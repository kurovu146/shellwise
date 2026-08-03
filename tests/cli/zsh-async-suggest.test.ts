/**
 * Suggestions may lag on a bad link. Typing may not.
 *
 * The query used to block ZLE until the daemon answered, so on `sw ssh` every
 * keystroke waited out a network round trip and the lag piled up. Now the
 * request is fired off and the reply arrives through `zle -F`, so characters
 * appear at the speed they are typed no matter how slow the daemon is.
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
const SESSION = "sw-async";

let daemonProc: Subprocess | null = null;

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

/** Wait until `probe` shows up, up to `budgetMs`. Returns how long it took. */
function waitFor(probe: string, budgetMs: number): number {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (screen().includes(probe)) return Date.now() - start;
    Bun.sleepSync(40);
  }
  return -1;
}

function startShell(delayMs: number): { requests(): string[] } {
  const dir = mkdtempSync(join(tmpdir(), "sw-async-"));
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
    "tmux", "new-session", "-d", "-s", SESSION, "-x", "110", "-y", "20",
    `env ZDOTDIR=${zdot} SHELLWISE_SOCKET=${socket} zsh -i`,
  ]);
  Bun.sleepSync(1500);

  return {
    requests: () =>
      existsSync(log)
        ? readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string)
        : [],
  };
}

describe.skipIf(!zsh || !tmux)("typing against a very slow daemon", () => {
  test("the next keystroke lands while the previous query is still in flight", () => {
    // 800 ms per reply, worse than any real link. Type two characters to start
    // a query, then one more: with a blocking query that third character can
    // only appear once the reply is in, i.e. ~800 ms late.
    startShell(800);

    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "gi"]);
    Bun.sleepSync(120);

    const start = Date.now();
    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "t"]);
    const shown = waitFor("% git", 3000);
    const elapsed = Date.now() - start;

    expect(shown).toBeGreaterThanOrEqual(0);
    // Room for tmux and polling, but nowhere near the 800 ms round trip.
    expect(elapsed).toBeLessThan(300);
  });

  test("a burst of ten characters is not slowed by the link at all", () => {
    startShell(800);

    const start = Date.now();
    for (const ch of ["g", "i", "t", " ", "s", "t", "a", "t", "u", "s"]) {
      Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, ch]);
      Bun.sleepSync(50);
    }
    const found = waitFor("% git status", 3000);
    const elapsed = Date.now() - start;

    expect(found).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(1500);
  });

  test("the suggestion still arrives, just later", () => {
    startShell(600);

    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "git st"]);
    const found = waitFor("git status", 5000);

    expect(found).toBeGreaterThanOrEqual(0);
    expect(screen()).toContain("history");
    expect(screen()).toContain("╭");
  });

  test("a late reply does not overwrite what the user typed since", () => {
    startShell(700);

    // Start a query on "git st", then keep typing while it is in flight. The
    // reply that comes back belongs to the old line and must be discarded.
    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "git st"]);
    Bun.sleepSync(150);
    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "ash"]);
    Bun.sleepSync(2500);

    const s = screen();
    // Whatever is on screen, the typed line must still be intact.
    expect(s).toContain("% git stash");
  });
});
