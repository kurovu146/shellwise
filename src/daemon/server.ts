import { getDb, closeDb } from "../db/connection";
import { insertCommand } from "../db/queries";
import { getHostname } from "../utils/platform";
import { getCommonSuggestions } from "../data/common-commands";
import { IGNORED_COMMANDS } from "../utils/constants";
import { parseRequest, getSocketPath, getPidPath, getDaemonPort } from "./protocol";
import { unlinkSync, writeFileSync, existsSync } from "fs";
import type { Socket } from "bun";
const IDLE_TIMEOUT = 30 * 60_000; // 30 min

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let server: ReturnType<typeof Bun.listen> | null = null;
let tcpServer: ReturnType<typeof Bun.listen> | null = null;

// Pre-warm DB + prepared statements on start
let suggestPrefix: ReturnType<ReturnType<typeof getDb>["prepare"]>;
let suggestContains: ReturnType<ReturnType<typeof getDb>["prepare"]>;

function initPreparedStatements() {
  const db = getDb();
  suggestPrefix = db.prepare(
    `SELECT command FROM command_stats
     WHERE command LIKE ?1 || '%' ESCAPE '\\'
     ORDER BY frecency_score DESC
     LIMIT ?2`
  );
  suggestContains = db.prepare(
    `SELECT command FROM command_stats
     WHERE command LIKE '%' || ?1 || '%' ESCAPE '\\' AND command != ?1
     ORDER BY frecency_score DESC
     LIMIT ?2`
  );
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    stopServer();
  }, IDLE_TIMEOUT);
}

function handleRequest(raw: string): string {
  const req = parseRequest(raw);
  if (!req) return "\n";

  resetIdleTimer();

  switch (req.type) {
    case "PING":
      return "PONG\n\n";

    case "SUGGEST": {
      if (!req.query || req.query.length < 2) return "\n";

      const historyResults: string[] = [];
      const historyLimit = 5;

      // Escape LIKE wildcards in user input
      const escapedQuery = req.query.replace(/[%_\\]/g, "\\$&");

      // History: prefix matches
      const prefixes = suggestPrefix.all(escapedQuery, historyLimit) as { command: string }[];
      for (const r of prefixes) {
        if (r.command !== req.query) historyResults.push(r.command);
      }

      // History: contains matches (fill remaining)
      if (historyResults.length < historyLimit) {
        const remaining = historyLimit - historyResults.length;
        const resultSet = new Set(historyResults);
        const contains = suggestContains.all(escapedQuery, remaining + historyResults.length) as {
          command: string;
        }[];
        for (const r of contains) {
          if (!resultSet.has(r.command) && r.command !== req.query) {
            historyResults.push(r.command);
            if (historyResults.length >= historyLimit) break;
          }
        }
      }

      // Common commands: fill with suggestions not already in history
      const seen = new Set(historyResults);
      const commonResults = getCommonSuggestions(req.query, 10)
        .filter((cmd) => !seen.has(cmd) && cmd !== req.query)
        .slice(0, 5);

      // Merge: history first, then common
      const merged = [...historyResults, ...commonResults];

      return merged.length > 0 ? merged.join("\n") + "\n\n" : "\n";
    }

    case "ADD": {
      const cmd = req.command.trim();
      if (!cmd || cmd.length < 2 || cmd.startsWith(" ")) return "OK\n\n";
      if (req.exitCode !== 0) return "OK\n\n"; // Only save successful commands
      const baseCmd = cmd.split(/\s+/)[0];
      if (IGNORED_COMMANDS.has(baseCmd)) return "OK\n\n";

      insertCommand({
        command: cmd,
        cwd: req.cwd || undefined,
        exit_code: req.exitCode,
        duration_ms: req.duration,
        hostname: getHostname(),
        session_id: req.session || undefined,
        shell: req.shell || undefined,
      });
      return "OK\n\n";
    }

    case "STOP":
      setTimeout(() => stopServer(), 50);
      return "BYE\n\n";
  }
}

export function startServer(): void {
  const socketPath = getSocketPath();
  const pidPath = getPidPath();

  // Cleanup stale socket
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {}
  }

  // Init DB + prepared statements
  initPreparedStatements();

  const socketHandlers = {
    data(socket: Socket, data: Buffer) {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          const response = handleRequest(line);
          socket.write(response);
        }
      }
    },
    open() {},
    close() {},
    error(_socket: Socket, error: Error) {
      console.error("[shellwise daemon] socket error:", error.message);
    },
  };

  // Listen on both Unix socket and TCP (for ztcp from zsh)
  server = Bun.listen({
    unix: socketPath,
    socket: socketHandlers,
  });

  const port = getDaemonPort();
  tcpServer = Bun.listen({
    hostname: "127.0.0.1",
    port,
    socket: socketHandlers,
  });

  // Save PID + port
  writeFileSync(pidPath, `${process.pid}\n${port}`);

  resetIdleTimer();

  // Cleanup on exit
  const cleanup = () => {
    stopServer();
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

export function stopServer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (server) {
    server.stop(true);
    server = null;
  }
  if (tcpServer) {
    tcpServer.stop(true);
    tcpServer = null;
  }
  closeDb();

  const socketPath = getSocketPath();
  const pidPath = getPidPath();
  try {
    unlinkSync(socketPath);
  } catch {}
  try {
    unlinkSync(pidPath);
  } catch {}

  process.exit(0);
}

export function isDaemonRunning(): boolean {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return false;

  try {
    const content = require("fs").readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content.split("\n")[0]);
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    // Stale PID file
    try {
      unlinkSync(pidPath);
    } catch {}
    return false;
  }
}

export function getDaemonInfo(): { pid: number; port: number } | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const content = require("fs").readFileSync(pidPath, "utf-8").trim();
    const lines = content.split("\n");
    return { pid: parseInt(lines[0]), port: parseInt(lines[1]) };
  } catch {
    return null;
  }
}
