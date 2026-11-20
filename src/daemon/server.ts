import { getDb, closeDb } from "../db/connection";
import { insertCommand } from "../db/queries";
import { getHostname } from "../utils/platform";
import { getCommonSuggestions } from "../data/common-commands";
import { checkForUpdate, getUpdateNotice } from "../utils/update-check";
import { parseRequest, getSocketPath, getPidPath, formatSuggestResponse } from "./protocol";
import { FRECENCY_EXPR } from "../db/frecency";
import { unlinkSync, writeFileSync, existsSync, chmodSync, readFileSync, statSync } from "fs";
import { probeDaemon } from "./client";
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

export function initPreparedStatements() {
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

export function handleRequest(raw: string): string {
  const req = parseRequest(raw);
  if (!req) return "\n\n";

  resetIdleTimer();

  switch (req.type) {
    case "PING":
      return "PONG\n\n";

    case "SUGGEST": {
      if (!req.query || req.query.length < 2) return "\n\n";

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

      // History first, then common — each line keeps its origin so the shell
      // can tag it.
      return formatSuggestResponse(
        [
          ...historyResults.map((command) => ({ command, source: "history" as const })),
          ...commonResults.map((command) => ({ command, source: "common" as const })),
        ],
        req.tagged
      );
    }

    case "ADD": {
      const cmd = req.command.trim();
      if (!cmd || cmd.length < 2 || cmd.startsWith(" ")) return "OK\n\n";
      if (req.exitCode !== 0) return "OK\n\n";
      // shellwise's own commands are recorded like any other: the internal
      // calls never reach this path (suggestions go over the socket, Ctrl+R
      // runs inside a widget), so anything arriving here was typed by hand.
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

/**
 * Takes the pid file as the endpoint's lock: created exclusively, so of
 * daemons starting at once (two shells opening together) exactly one gets it.
 * False when a live daemon holds it. A stale one (dead pid, or a live pid that
 * never answered) is removed and the create retried; twice at most, since
 * the holder that replaced it can be slow too.
 */
async function takePidFile(pidPath: string): Promise<boolean> {
  const create = (): boolean => {
    try {
      writeFileSync(pidPath, `${process.pid}`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return false;
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (create()) return true;
    const owner = await endpointOwner();
    if (owner.live) return false;
    if (owner.content !== null) removePidFileIf(owner.content);
  }
  // The stale holder was just removed: this one becomes the daemon, rather
  // than leave the endpoint with none (the stale holder leaves on its own
  // ownership check).
  return create();
}

/**
 * A test-only start delay from the environment, in ms: 0 when unset or not a
 * positive number, and at most a minute, so that no value can keep a daemon
 * holding the pid file without ever binding.
 */
export function parseTestDelay(raw: string | undefined): number {
  const ms = Number(raw ?? 0);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : 0;
}

export async function startServer(): Promise<void> {
  const socketPath = getSocketPath();
  const pidPath = getPidPath();

  // Only the lock holder touches the socket path: unlinking it would cut off
  // a daemon that is already serving there.
  if (!(await takePidFile(pidPath))) process.exit(0);

  try {
    initPreparedStatements();
    // Test-only: makes this start slower than the grace.
    const bindDelay = parseTestDelay(process.env.SHELLWISE_TEST_BIND_DELAY_MS);
    if (bindDelay > 0) await Bun.sleep(bindDelay);
    // Slower than the grace, this start may have been judged stale and
    // another one taken the pid file: then the socket path is that one's
    // (it may be serving there already). Leave it alone.
    if (!ownsPidFile()) process.exit(0);
    // Test-only: a take-over between the check above and the bind, which
    // only the check after the bind can see.
    const unlinkDelay = parseTestDelay(process.env.SHELLWISE_TEST_UNLINK_DELAY_MS);
    if (unlinkDelay > 0) await Bun.sleep(unlinkDelay);
    // A leftover socket file of a daemon that died (or of one that lost the
    // pid file to us and left): removed right before the bind, not earlier.
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {}
    }
    listen(socketPath);
  } catch (e) {
    // Give the lock back, or every later start would wait for this one.
    removePidFileIf(`${process.pid}`);
    throw e;
  }

  // The same, when the pid file was taken while this one was binding. The
  // owner removes this socket file right before its own bind: leave without
  // stopping the listener, since stopping it deletes whatever is at the
  // socket path (on Windows), which may already be the owner's.
  if (!ownsPidFile()) process.exit(0);

  resetIdleTimer();

  // Cleanup on exit
  const cleanup = () => {
    stopServer();
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

function listen(socketPath: string): void {
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
}

// A daemon writes its pid file before it binds the socket, so for a moment
// its pid is alive and nothing answers yet. For this long after the file was
// written, that is a daemon still starting, not a stale file.
const START_GRACE_MS = 3000;

function readPidFile(): string | null {
  try {
    return readFileSync(getPidPath(), "utf-8");
  } catch {
    return null;
  }
}

function pidOf(content: string): number {
  return parseInt(content.trim().split("\n")[0]);
}

function pidAlive(pid: number): boolean {
  // 0 and negative pids address process groups in process.kill.
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Removes the pid file only if it still holds `content`, never a successor's. */
function removePidFileIf(content: string): void {
  if (readPidFile() !== content) return;
  try {
    unlinkSync(getPidPath());
  } catch {}
}

/**
 * Who holds the endpoint. Live: the pid file's pid is alive and somebody is
 * listening on the socket (answering, or connected but busy). A live pid that
 * does not answer yet is waited for while its pid file is younger than
 * START_GRACE_MS, and for at most that long in all, timed by this process:
 * the file's mtime can be in the future after the clock was set back.
 * Otherwise not live, with the pid file content judged stale (null when
 * there is no pid file).
 */
async function endpointOwner(): Promise<{ live: true } | { live: false; content: string | null }> {
  const waitUntil = performance.now() + START_GRACE_MS;
  while (true) {
    const content = readPidFile();
    if (content === null || !pidAlive(pidOf(content))) return { live: false, content };
    if ((await probeDaemon()) !== "unreachable") return { live: true };
    let age = Infinity;
    try {
      age = Date.now() - statSync(getPidPath()).mtimeMs;
    } catch {}
    if (age >= START_GRACE_MS || performance.now() >= waitUntil) return { live: false, content };
    await Bun.sleep(50);
  }
}

function ownsPidFile(): boolean {
  const content = readPidFile();
  return content !== null && pidOf(content) === process.pid;
}

export function stopServer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  closeDb();

  // Decide ownership FIRST: on Windows server.stop() itself deletes whatever
  // file sits at the socket path, which for a daemon that lost ownership is
  // the successor's. A non-owner exits without stopping the listener or
  // unlinking anything.
  if (ownsPidFile()) {
    if (server) {
      server.stop(true);
      server = null;
    }
    try {
      unlinkSync(getSocketPath());
    } catch {}
    try {
      unlinkSync(getPidPath());
    } catch {}
  }

  process.exit(0);
}

export function isDaemonRunning(): boolean {
  const content = readPidFile();
  if (content === null) return false;
  if (pidAlive(pidOf(content))) return true;
  // Stale PID file
  removePidFileIf(content);
  return false;
}

/**
 * "Running" for the CLI's decisions: the pid is alive AND somebody is
 * listening on the socket. A pid file alone proves little on Windows, where
 * %TEMP% survives reboots and pids are recycled. Stale means nobody listens
 * (no socket file, or the connect fails) past a starting daemon's grace: the
 * stale pid file is then removed so a fresh daemon can take over. A leftover
 * socket file is left to that daemon, which removes it once it holds the pid
 * file: removed from here, it could be the new daemon's. A daemon that accepts
 * the connection but is too busy to answer in time is alive and left alone.
 */
export async function isDaemonLive(): Promise<boolean> {
  const owner = await endpointOwner();
  if (owner.live) return true;
  if (owner.content !== null) removePidFileIf(owner.content);
  return false;
}

export function getDaemonInfo():{ pid: number } | null {
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
