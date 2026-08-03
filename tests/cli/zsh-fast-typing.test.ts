/**
 * Typing fast must not pile up queries.
 *
 * Every keystroke asked the daemon and waited for the answer. On a local socket
 * that is 1–3 ms and nobody notices; over `sw ssh` it is a full network round
 * trip, so each character had to wait out the previous one's — measured at
 * 227 ms per character, 2.3 s for ten. The fix: while more keys are already
 * waiting in the input buffer ($PENDING), skip the query and let the last
 * keystroke of the burst do it.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateZshScript } from "../../src/cli/init";
import { hasZsh } from "./zsh-harness";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Subprocess } from "bun";

const zsh = hasZsh();
const tmux = Bun.spawnSync(["which", "tmux"]).exitCode === 0;
const SESSION = "sw-fast-typing";

let daemonProc: Subprocess | null = null;

function killSession() {
  Bun.spawnSync(["tmux", "kill-session", "-t", SESSION], { stderr: "ignore" });
}

afterEach(() => {
  killSession();
  daemonProc?.kill();
  daemonProc = null;
});

/** Start a shell whose daemon answers `delayMs` later, as a remote one would. */
function startShell(delayMs: number): { suggests(): string[] } {
  const dir = mkdtempSync(join(tmpdir(), "sw-fast-"));
  const socket = join(dir, "d.sock");
  const log = join(dir, "req.log");
  const script = join(dir, "sw.zsh");
  const zdot = join(dir, "zdot");

  daemonProc = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fake-daemon.ts"),
    socket,
    log,
    Buffer.from("history\tgit status\ncommon\tgit stash\n\n").toString("base64"),
    String(delayMs),
  ]);
  const deadline = Date.now() + 5000;
  while (!existsSync(socket) && Date.now() < deadline) Bun.sleepSync(10);

  writeFileSync(script, generateZshScript("shellwise", { remote: true }));
  mkdirSync(zdot, { recursive: true });
  writeFileSync(join(zdot, ".zshrc"), `PROMPT='%% '\nsource ${script}\n`);

  killSession();
  Bun.spawnSync([
    "tmux", "new-session", "-d", "-s", SESSION, "-x", "100", "-y", "20",
    `env ZDOTDIR=${zdot} SHELLWISE_SOCKET=${socket} zsh -i`,
  ]);
  Bun.sleepSync(1500);

  return {
    suggests: () =>
      existsSync(log)
        ? readFileSync(log, "utf-8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as string)
            .filter((r) => r.startsWith("SUGGEST"))
        : [],
  };
}

describe.skipIf(!zsh || !tmux)("typing a burst of characters", () => {
  test("asks the daemon once at the end, not once per key", () => {
    const shell = startShell(150);

    // Ten characters in one go, the way a fast typist or a paste-less burst
    // arrives: tmux delivers them faster than one round trip.
    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "git status"]);
    Bun.sleepSync(2500);

    const suggests = shell.suggests();
    // Before the fix this was one query per character after the 2-char floor.
    expect(suggests.length).toBeLessThanOrEqual(3);
    expect(suggests.length).toBeGreaterThan(0);
    // And the one that ran used the finished line.
    expect(suggests[suggests.length - 1]).toContain("git status");
  });

  test("still suggests normally when typing at a human pace", () => {
    const shell = startShell(10);

    for (const ch of ["g", "i", "t", " ", "s"]) {
      Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, ch]);
      Bun.sleepSync(250);
    }
    Bun.sleepSync(500);

    const suggests = shell.suggests();
    // One per keystroke past the two-character floor.
    expect(suggests.length).toBeGreaterThanOrEqual(3);

    const screen = Bun.spawnSync(["tmux", "capture-pane", "-t", SESSION, "-p"]).stdout.toString();
    expect(screen).toContain("git status");
    expect(screen).toContain("history");
  });
});
