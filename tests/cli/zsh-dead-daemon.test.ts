/**
 * A daemon that goes away must not leave the shell burning a core.
 *
 * `zle -F fd handler` fires whenever the fd is readable — and a socket whose
 * peer has closed is readable *forever*, returning EOF every time. If the
 * handler just reads what it can and returns, ZLE calls it again immediately,
 * and that is a tight loop for as long as the pane stays open: measured in the
 * field at ~93% CPU per idle pane, one of them for six days at 1.3 GB RSS
 * (2026-08-17). The handler has to notice EOF and unregister itself.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateZshScript } from "../../src/cli/init";
import { hasZsh } from "./zsh-harness";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Subprocess } from "bun";

const zsh = hasZsh();
const tmux = Bun.spawnSync(["which", "tmux"]).exitCode === 0;
const SESSION = "sw-dead-daemon";

let daemonProc: Subprocess | null = null;
let socketPath = "";

function killSession() {
  Bun.spawnSync(["tmux", "kill-session", "-t", SESSION], { stderr: "ignore" });
}

afterEach(() => {
  killSession();
  daemonProc?.kill();
  daemonProc = null;
});

function screen(): string {
  return Bun.spawnSync(["tmux", "capture-pane", "-t", SESSION, "-p"]).stdout.toString();
}

function waitFor(probe: string, budgetMs: number): boolean {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (screen().includes(probe)) return true;
    Bun.sleepSync(40);
  }
  return false;
}

function panePid(): number {
  const out = Bun.spawnSync(["tmux", "list-panes", "-t", SESSION, "-F", "#{pane_pid}"])
    .stdout.toString()
    .trim();
  return Number(out.split("\n")[0]);
}

/** Seconds of CPU this process has consumed so far, from `ps -o cputime`. */
function cpuSeconds(pid: number): number {
  const raw = Bun.spawnSync(["ps", "-o", "cputime=", "-p", String(pid)]).stdout.toString().trim();
  if (!raw) throw new Error(`no such pid ${pid}`);
  // "MM:SS.ss" or "HH:MM:SS.ss"
  const parts = raw.split(":").map(Number);
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

/** How many of this shell's sockets have lost their peer (`->(none)` in lsof). */
function deadSockets(pid: number): number {
  const out = Bun.spawnSync(["lsof", "-p", String(pid)], { stderr: "ignore" }).stdout.toString();
  return out.split("\n").filter((l) => l.includes("unix") && l.includes("->(none)")).length;
}

function spawnDaemon(socket: string, log: string) {
  daemonProc = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fake-daemon.ts"),
    socket,
    log,
    Buffer.from("history\tgit status\ncommon\tgit stash\n\n").toString("base64"),
    "0",
  ]);
  const deadline = Date.now() + 5000;
  while (!existsSync(socket) && Date.now() < deadline) Bun.sleepSync(10);
  if (!existsSync(socket)) throw new Error("fake daemon never came up");
}

function startShell(): { log: string } {
  const dir = mkdtempSync(join(tmpdir(), "sw-dead-"));
  socketPath = join(dir, "d.sock");
  const log = join(dir, "req.log");
  const script = join(dir, "sw.zsh");
  const zdot = join(dir, "zdot");

  spawnDaemon(socketPath, log);

  writeFileSync(script, generateZshScript("shellwise", { remote: true }));
  mkdirSync(zdot, { recursive: true });
  writeFileSync(join(zdot, ".zshrc"), `PROMPT='%% '\nsource ${script}\n`);

  killSession();
  Bun.spawnSync([
    "tmux", "new-session", "-d", "-s", SESSION, "-x", "110", "-y", "20",
    `env ZDOTDIR=${zdot} SHELLWISE_SOCKET=${socketPath} zsh -i`,
  ]);
  Bun.sleepSync(1500);
  return { log };
}

/** Open the async channel and prove it works, so the fd under test is live. */
function openAsyncChannel() {
  Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "gi"]);
  expect(waitFor("git status", 4000)).toBe(true);
}

describe.skipIf(!zsh || !tmux)("when the daemon dies under a live async channel", () => {
  test("the idle shell stays off the CPU instead of spinning on the closed socket", () => {
    startShell();
    openAsyncChannel();

    daemonProc?.kill();
    daemonProc = null;
    Bun.sleepSync(400);

    const pid = panePid();
    const before = cpuSeconds(pid);
    Bun.sleepSync(3000);
    const burned = cpuSeconds(pid) - before;

    // A spinning handler burns the whole wall-clock window; an idle shell
    // burns approximately nothing. The gap is three orders of magnitude, so
    // any threshold in between separates them.
    expect(burned).toBeLessThan(0.3);
  });

  test("the dead fd is let go rather than left registered", () => {
    startShell();
    openAsyncChannel();

    daemonProc?.kill();
    daemonProc = null;
    Bun.sleepSync(1500);

    // The reply handler holds the only fd that can lose its peer while the
    // shell sits idle; if it unregistered and closed, nothing is left dangling.
    expect(deadSockets(panePid())).toBe(0);
  });

  test("typing reconnects once a daemon is back, without stacking dead fds", () => {
    const { log } = startShell();
    openAsyncChannel();

    daemonProc?.kill();
    daemonProc = null;
    Bun.sleepSync(500);

    spawnDaemon(socketPath, log);
    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "C-u"]);
    Bun.sleepSync(200);
    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "git st"]);

    expect(waitFor("git stash", 5000)).toBe(true);
    expect(deadSockets(panePid())).toBe(0);
  });
});
