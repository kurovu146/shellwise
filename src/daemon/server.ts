import { getDb, closeDb } from "../db/connection";
import { insertCommand } from "../db/queries";
import { getHostname } from "../utils/platform";
import { getCommonSuggestions } from "../data/common-commands";
import { checkForUpdate, getUpdateNotice } from "../utils/update-check";
import { parseRequest, getSocketPath, getPidPath } from "./protocol";
import { FRECENCY_EXPR } from "../db/frecency";
import { unlinkSync, writeFileSync, existsSync, chmodSync } from "fs";
import type { Socket } from "bun";

// Reject a connection that floods us without ever sending a newline.
const MAX_LINE_BYTES = 64 * 1024;
const IDLE_TIMEOUT = 30 * 60_000; // 30 min

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let server: ReturnType<typeof Bun.listen> | null = null;
let updateNotified = false;

// Pre-warm DB + prepared statements on start
let suggestPrefix: ReturnType<ReturnType<typeof getDb>["prepare"]>;
let suggestContains: ReturnType<ReturnType<typeof getDb>["prepare"]>;

function initPreparedStatements() {
  const db = getDb();
  suggestPrefix = db.prepare(
    `SELECT command FROM command_stats
     WHERE command LIKE ?1 || '%' ESCAPE '\\'
     ORDER BY ${FRECENCY_EXPR} DESC
     LIMIT ?2`
  );
  suggestContains = db.prepare(
    `SELECT command FROM command_stats
     WHERE command LIKE '%' || ?1 || '%' ESCAPE '\\' AND command != ?1
     ORDER BY ${FRECENCY_EXPR} DESC
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

      // History: prefix matches (exact match first)
      const prefixes = suggestPrefix.all(escapedQuery, historyLimit) as { command: string }[];
      for (const r of prefixes) {
        if (r.command === req.query) {
          historyResults.unshift(r.command);
        } else {
          historyResults.push(r.command);
        }
      }

      // History: contains matches (fill remaining)
      if (historyResults.length < historyLimit) {
        const remaining = historyLimit - historyResults.length;
        const resultSet = new Set(historyResults);
        const contains = suggestContains.all(escapedQuery, remaining + historyResults.length) as {
          command: string;
        }[];
        for (const r of contains) {
          if (!resultSet.has(r.command)) {
            historyResults.push(r.command);
            if (historyResults.length >= historyLimit) break;
          }
        }
      }

      // Common commands: fill with suggestions not already in history
      const seen = new Set(historyResults);
      const commonResults = getCommonSuggestions(req.query, 10)
        .filter((cmd) => !seen.has(cmd))
        .slice(0, 5);

      // Merge: history first, then common
      const merged = [...historyResults, ...commonResults];

      return merged.length > 0 ? merged.join("\n") + "\n\n" : "\n";
    }

    case "ADD": {
      const cmd = req.command.trim();
      if (!cmd || cmd.length < 2 || cmd.startsWith(" ")) return "OK\n\n";
      if (req.exitCode !== 0) return "OK\n\n";
      const baseCmd = cmd.split(/\s+/)[0];
      if (baseCmd === "shellwise" || baseCmd === "sw") return "OK\n\n";
      insertCommand({
        command: cmd,
        cwd: req.cwd || undefined,
        exit_code: req.exitCode,
        duration_ms: req.duration,
        hostname: getHostname(),
        session_id: req.session || undefined,
        shell: req.shell || undefined,
      });

      // Check update notice from cache (sync, fast, once per daemon session)
      const pkg = require("../../package.json");
      if (!updateNotified) {
        const notice = getUpdateNotice(pkg.version);
        if (notice) {
          updateNotified = true;
          // Refresh cache in background
          checkForUpdate(pkg.version, true).catch(() => {});
          return `OK\nUPDATE\t${notice}\n\n`;
        }
      }

      // Refresh cache in background for next time
      checkForUpdate(pkg.version, true).catch(() => {});

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
    open(socket: Socket) {
      // Per-connection accumulator: TCP/stream sockets don't preserve message
      // boundaries, so buffer partial reads and only act on complete lines.
      (socket as unknown as { buf: string }).buf = "";
    },
    data(socket: Socket, data: Buffer) {
      const state = socket as unknown as { buf: string };
      let buf = state.buf + data.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) socket.write(handleRequest(line));
      }
      // Drop a pathologically long line with no terminator (flood guard)
      state.buf = buf.length > MAX_LINE_BYTES ? "" : buf;
    },
    close() {},
    error(_socket: Socket, error: Error) {
      console.error("[shellwise daemon] socket error:", error.message);
    },
  };

  // Unix-domain socket only — protected by filesystem permissions (0600).
  // No TCP: a guessable localhost port with no auth would let any local
  // process poison history or read it.
  server = Bun.listen({
    unix: socketPath,
    socket: socketHandlers,
  });
  try {
    chmodSync(socketPath, 0o600);
  } catch {}

  // Save PID (owner-only)
  writeFileSync(pidPath, `${process.pid}`, { mode: 0o600 });

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

export function getDaemonInfo(): { pid: number } | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const content = require("fs").readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content.split("\n")[0]);
    return Number.isNaN(pid) ? null : { pid };
  } catch {
    return null;
  }
}
