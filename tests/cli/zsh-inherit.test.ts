/**
 * A nested shell must not record its parent's command.
 *
 * __SW_COMMAND used to be exported, so any shell started from another shell
 * inherited it and, on its very first prompt, saved the parent's command again
 * — with the child's cwd and session id. Opening a subshell (tmux, a script,
 * `zsh` inside `zsh`) silently double-counted whatever was running. It showed
 * up while recording the demo GIF: the `claude` process that spawned the
 * recording ended up in the demo history.
 *
 * The behavioural test needs a real prompt, because that is when precmd runs —
 * hence tmux rather than `zsh -f script`.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateZshScript, generateBashScript } from "../../src/cli/init";
import { hasZsh } from "./zsh-harness";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Subprocess } from "bun";

const zsh = hasZsh();
const tmux = Bun.spawnSync(["which", "tmux"]).exitCode === 0;
const SESSION = "sw-inherit";

let daemonProc: Subprocess | null = null;

function killSession() {
  Bun.spawnSync(["tmux", "kill-session", "-t", SESSION], { stderr: "ignore" });
}

afterEach(() => {
  killSession();
  daemonProc?.kill();
  daemonProc = null;
});

describe("command capture state", () => {
  test("zsh keeps it out of the environment", () => {
    const script = generateZshScript("shellwise");
    expect(script).not.toContain("export __SW_COMMAND");
    expect(script).not.toContain("export __SW_START_TIME");
    // And clears anything an older release leaked in.
    expect(script).toContain("unset __SW_COMMAND __SW_START_TIME");
  });

  test("bash keeps it out of the environment", () => {
    const script = generateBashScript("shellwise");
    expect(script).not.toContain("export __SW_COMMAND");
    expect(script).not.toContain("export __SW_START_TIME");
    expect(script).toContain("unset __SW_COMMAND __SW_START_TIME");
  });
});

describe.skipIf(!zsh || !tmux)("a nested interactive shell", () => {
  test("does not record the command its parent was running", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-inherit-"));
    const socket = join(dir, "d.sock");
    const log = join(dir, "requests.log");
    const script = join(dir, "sw.zsh");
    const zdot = join(dir, "zdot");

    daemonProc = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "fake-daemon.ts"),
      socket,
      log,
      Buffer.from("OK\n\n").toString("base64"),
    ]);
    const deadline = Date.now() + 5000;
    while (!existsSync(socket) && Date.now() < deadline) Bun.sleepSync(10);

    writeFileSync(script, generateZshScript("shellwise", { remote: true }));
    Bun.spawnSync(["mkdir", "-p", zdot]);
    writeFileSync(join(zdot, ".zshrc"), `PROMPT='%% '\nsource ${script}\n`);

    killSession();
    Bun.spawnSync([
      "tmux",
      "new-session",
      "-d",
      "-s",
      SESSION,
      // Exactly what a child shell would inherit from a parent mid-command.
      `env ZDOTDIR=${zdot} SHELLWISE_SOCKET=${socket} __SW_COMMAND=claude __SW_START_TIME=1000 zsh -i`,
    ]);
    Bun.sleepSync(2000);

    const requests = existsSync(log)
      ? readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string)
      : [];
    const adds = requests.filter((r) => r.startsWith("ADD"));
    expect(adds).toEqual([]);
  });

  test("still records a command run in this shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-inherit-ok-"));
    const socket = join(dir, "d.sock");
    const log = join(dir, "requests.log");
    const script = join(dir, "sw.zsh");
    const zdot = join(dir, "zdot");

    daemonProc = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "fake-daemon.ts"),
      socket,
      log,
      Buffer.from("OK\n\n").toString("base64"),
    ]);
    const deadline = Date.now() + 5000;
    while (!existsSync(socket) && Date.now() < deadline) Bun.sleepSync(10);

    writeFileSync(script, generateZshScript("shellwise", { remote: true }));
    Bun.spawnSync(["mkdir", "-p", zdot]);
    writeFileSync(join(zdot, ".zshrc"), `PROMPT='%% '\nsource ${script}\n`);

    killSession();
    Bun.spawnSync([
      "tmux",
      "new-session",
      "-d",
      "-s",
      SESSION,
      `env ZDOTDIR=${zdot} SHELLWISE_SOCKET=${socket} zsh -i`,
    ]);
    Bun.sleepSync(1500);
    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "true marker-command", "Enter"]);
    Bun.sleepSync(1500);

    const requests = existsSync(log)
      ? readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string)
      : [];
    const adds = requests.filter((r) => r.startsWith("ADD"));
    expect(adds.length).toBeGreaterThan(0);
    expect(adds.some((a) => a.includes("marker-command"))).toBe(true);
  });
});
