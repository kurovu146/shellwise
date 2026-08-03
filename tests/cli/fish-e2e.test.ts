/**
 * The frame is drawn with raw escape codes, so the only way to know it works is
 * to run fish in a real terminal and look at the screen. tmux gives us one.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateFishScript } from "../../src/cli/init/fish";
import { hasFish } from "./fish-harness";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Subprocess } from "bun";

const fish = hasFish();
const tmux = Bun.spawnSync(["which", "tmux"]).exitCode === 0;
const SESSION = "sw-fish-e2e";

let daemonProc: Subprocess | null = null;

function killSession() {
  Bun.spawnSync(["tmux", "kill-session", "-t", SESSION], { stderr: "ignore" });
}

afterEach(() => {
  killSession();
  daemonProc?.kill();
  daemonProc = null;
});

function startSession(reply: string, cols = 60): void {
  const dir = mkdtempSync(join(tmpdir(), "sw-e2e-"));
  const socket = join(dir, "d.sock");
  const script = join(dir, "sw.fish");
  const config = join(dir, "config.fish");

  daemonProc = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fake-daemon.ts"),
    socket,
    join(dir, "req.log"),
    Buffer.from(reply).toString("base64"),
  ]);
  const deadline = Date.now() + 5000;
  while (!existsSync(socket) && Date.now() < deadline) Bun.sleepSync(10);

  writeFileSync(script, generateFishScript("shellwise"));
  // The socket must be exported before sourcing: the script reads it at load
  // time, and without it the test would talk to the developer's real daemon.
  writeFileSync(
    config,
    `set -gx SHELLWISE_SOCKET ${socket}\nfunction fish_prompt; printf '%% '; end\nsource ${script}\n`
  );

  killSession();
  Bun.spawnSync([
    "tmux",
    "new-session",
    "-d",
    "-s",
    SESSION,
    `fish --init-command "source ${config}"`,
  ]);
  Bun.spawnSync(["tmux", "resize-window", "-t", SESSION, "-x", String(cols), "-y", "16"], {
    stderr: "ignore",
  });
  Bun.sleepSync(1500);
}

function screen(): string {
  return Bun.spawnSync(["tmux", "capture-pane", "-t", SESSION, "-p"]).stdout.toString();
}

function send(keys: string, wait = 700) {
  Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, keys]);
  Bun.sleepSync(wait);
}

describe.skipIf(!fish || !tmux)("fish in a real terminal", () => {
  test("typing brings up the frame with tags", () => {
    startSession("history\tgit status\nhistory\tgit stash pop\ncommon\tgit switch\n\n");
    send("git st");
    const s = screen();
    expect(s).toContain("╭");
    expect(s).toContain("git status");
    expect(s).toContain("history");
    expect(s).toContain("common");
  });

  test("Tab writes the selected command into the line", () => {
    startSession("history\tgit status\nhistory\tgit stash pop\n\n");
    send("git st");
    send("Tab");
    const s = screen();
    expect(s).toContain("% git status");
    expect(s).toContain("› git status");
  });

  test("Esc wipes the frame off the screen", () => {
    startSession("history\tgit status\nhistory\tgit stash\nhistory\tgit switch\n\n");
    send("git");
    expect(screen()).toContain("╭");
    send("Escape");
    const after = screen();
    expect(after).not.toContain("╭");
    expect(after).not.toContain("╰");
    expect(after).not.toContain("│");
  });

  test("running a command leaves a clean screen behind", () => {
    startSession("history\techo hello\n\n");
    send("echo");
    send("C-u", 400);
    send("echo done-marker");
    send("Enter", 1000);
    const s = screen();
    expect(s).toContain("done-marker");
    expect(s).not.toContain("╭");
    expect(s).not.toContain("│");
  });
});
