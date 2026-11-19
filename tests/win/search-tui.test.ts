import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  drive,
  killTree,
  removeDir,
  startHiddenConsole,
  waitForExit,
  type KeyName,
  type Screen,
  type Step,
} from "./console-harness";

const REPO = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO, "src", "index.ts");
const GIT_COMMANDS = ["git status", "git stash pop"];
// Each test starts a console, a CLI and a driver; the driver polls for up to 10s.
const TEST_TIMEOUT_MS = 30_000;

// Runs `search --query git` as a child in its own console and records the
// console's input/output modes before and after it. A bun wrapper rather than
// run.cmd because cmd.exe resets the console modes after every command, which
// would hide a leak. VT output processing is switched off first, since this
// console starts with it on and leaving it on would otherwise go unnoticed.
// The CLI gets no stdin: when stdin is the console, Bun itself restores the
// input mode at exit, which would also hide a leak from the backend.
const MODES_WRAPPER = `
import { dlopen } from "bun:ffi";
import { openSync, writeFileSync } from "fs";
const [entry, out, err, modesOut] = process.argv.slice(2);
const k = dlopen("kernel32.dll", {
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
  GetConsoleMode: { args: ["u64", "ptr"], returns: "i32" },
  SetConsoleMode: { args: ["u64", "u32"], returns: "i32" },
}).symbols;
const open = (name) => k.CreateFileW(Buffer.from(name + "\\0", "utf16le"), 0xc0000000, 3, null, 3, 0, 0n);
const hIn = open("CONIN$");
const hOut = open("CONOUT$");
const m = new Uint32Array(1);
const mode = (h) => (k.GetConsoleMode(h, m), m[0]);
k.SetConsoleMode(hOut, mode(hOut) & ~0x4);
const before = mode(hIn).toString(16) + " " + mode(hOut).toString(16);
Bun.spawnSync([process.execPath, entry, "search", "--query", "git"], {
  stdin: "ignore",
  stdout: openSync(out, "w"),
  stderr: openSync(err, "w"),
});
writeFileSync(modesOut, before + "\\n" + mode(hIn).toString(16) + " " + mode(hOut).toString(16));
`;

describe.skipIf(process.platform !== "win32")("interactive search in a real Windows console", () => {
  let dir: string;
  let env: Record<string, string>;
  let pid: number | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sw-win-tui-"));
    env = {
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CONFIG_HOME: join(dir, "config"),
      // Nothing listens here, so the CLI falls back to the isolated DB.
      SHELLWISE_DAEMON_SOCKET: join(dir, "no-daemon.sock"),
    };
    for (const command of [...GIT_COMMANDS, "docker ps"]) {
      const p = Bun.spawnSync([process.execPath, ENTRY, "add", "--command", command], {
        env: { ...process.env, ...env },
      });
      expect(p.exitCode).toBe(0);
    }
  });

  afterEach(() => {
    if (pid !== null) killTree(pid);
    pid = null;
    removeDir(dir);
  });

  const file = (name: string) => join(dir, name);
  const read = (name: string) => readFileSync(file(name), "utf8");

  /** Start `search --query git` in a hidden console, stdout/stderr to files. */
  function startSearch(): number {
    const run = `@"${process.execPath}" "${ENTRY}" search --query git > "${file("selected.txt")}" 2> "${file("err.txt")}"`;
    writeFileSync(file("run.cmd"), run + "\r\n");
    pid = startHiddenConsole("cmd.exe", ["/c", file("run.cmd")], env);
    return pid;
  }

  /** Same search, under MODES_WRAPPER; modes.txt gets "before\nafter". */
  function startSearchRecordingModes(): number {
    writeFileSync(file("wrapper.ts"), MODES_WRAPPER);
    const args = [file("wrapper.ts"), ENTRY, file("selected.txt"), file("err.txt"), file("modes.txt")];
    pid = startHiddenConsole(process.execPath, args, env);
    return pid;
  }

  /** drive(), but a failure also shows what the CLI printed to stderr. */
  function driveSearch(p: number, steps: Step[]): Screen[] {
    try {
      return drive(p, steps);
    } catch (e) {
      let stderr = "";
      try {
        stderr = read("err.txt");
      } catch {}
      throw new Error(`${(e as Error).message}\n--- err.txt ---\n${stderr}`);
    }
  }

  const screen = (screens: Screen[], label: string) => screens.find((s) => s.label === label)!.lines;
  // The selected result row starts with "> "; its command runs up to the
  // padding before the time column.
  const selectedCommand = (lines: string[]) =>
    lines.find((l) => l.startsWith("> ") && GIT_COMMANDS.some((c) => l.includes(c)))?.slice(2).split(/\s{2,}/)[0];

  test("lists matching history and prints the row chosen with Down + Enter", () => {
    const p = startSearch();
    const screens = driveSearch(p, [
      { type: "waitFor", text: "git stash pop", timeoutMs: 10_000 },
      { type: "screen", label: "open" },
      { type: "key", value: "down" },
      { type: "waitForChange" },
      { type: "screen", label: "moved" },
      { type: "key", value: "enter" },
    ]);
    expect(waitForExit(p)).toBe(true);

    const open = screen(screens, "open");
    expect(open.some((l) => l.includes("git status"))).toBe(true);
    expect(open.some((l) => l.includes("git stash pop"))).toBe(true);
    expect(open.some((l) => l.includes("docker ps"))).toBe(false);
    // Box-drawing glyphs arrive intact: UTF-8 output is decoded as Unicode.
    expect(open.filter((l) => /^─+$/.test(l)).length).toBe(2);

    const first = selectedCommand(open);
    const moved = selectedCommand(screen(screens, "moved"));
    expect(GIT_COMMANDS).toContain(first!);
    expect(GIT_COMMANDS).toContain(moved!);
    expect(moved).not.toBe(first);

    expect(read("selected.txt")).toBe(moved!);
    expect(read("err.txt")).toBe("");
  }, TEST_TIMEOUT_MS);

  test("Escape cancels without printing anything", () => {
    const p = startSearch();
    driveSearch(p, [
      { type: "waitFor", text: "git stash pop", timeoutMs: 10_000 },
      { type: "key", value: "escape" },
    ]);
    expect(waitForExit(p)).toBe(true);

    expect(read("selected.txt")).toBe("");
    expect(read("err.txt")).toBe("");
  }, TEST_TIMEOUT_MS);

  test.each(["enter", "escape", "ctrl-c"] as KeyName[])("leaves the console modes as it found them after %s", (key) => {
    const p = startSearchRecordingModes();
    driveSearch(p, [
      { type: "waitFor", text: "git stash pop", timeoutMs: 10_000 },
      { type: "key", value: key },
    ]);
    expect(waitForExit(p)).toBe(true);

    const [before, after] = read("modes.txt").split("\n");
    expect(before).toMatch(/^[0-9a-f]+ [0-9a-f]+$/);
    expect(after).toBe(before);
    expect(read("err.txt")).toBe("");
  }, TEST_TIMEOUT_MS);
});
