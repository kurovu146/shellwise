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
// SW_TEST_BIN=<path to a compiled shellwise.exe> runs the CLI from that
// binary instead of `bun src/index.ts`.
const CLI = process.env.SW_TEST_BIN ? [process.env.SW_TEST_BIN] : [process.execPath, ENTRY];
const GIT_COMMANDS = ["git status", "git stash pop"];
// Each test starts a console, a CLI and a driver; the driver polls for up to 10s.
const TEST_TIMEOUT_MS = 30_000;

// Runs a command (by default `search --query git`) as a child in its own
// console and records the console's input/output modes before and after it,
// then the child's exit code. A bun wrapper rather than run.cmd because
// cmd.exe resets the console modes after every command, which would hide a
// leak. VT output processing is switched off first, since this console starts
// with it on and leaving it on would otherwise go unnoticed. The child gets no
// stdin: when stdin is the console, Bun itself restores the input mode at
// exit, which would also hide a leak from the backend. The wrapper ignores
// Ctrl+Break so it outlives a test that sends one.
const MODES_WRAPPER = `
import { dlopen } from "bun:ffi";
import { openSync, writeFileSync } from "fs";
const [out, err, modesOut, ...command] = process.argv.slice(2);
process.on("SIGBREAK", () => {});
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
const child = Bun.spawnSync(command, {
  stdin: "ignore",
  stdout: openSync(out, "w"),
  stderr: openSync(err, "w"),
});
const after = mode(hIn).toString(16) + " " + mode(hOut).toString(16);
writeFileSync(modesOut, [before, after, child.exitCode].join("\\n"));
`;

// Puts the console in raw mode through the real backend, then throws before
// any cleanup runs: what an error raised outside search.ts's try/finally does.
const THROW_AFTER_RAW = `
import { enableRawMode } from ${JSON.stringify(join(REPO, "src", "tui", "input.ts"))};
import { write } from ${JSON.stringify(join(REPO, "src", "tui", "renderer.ts"))};
enableRawMode();
write("drawing\\r\\n");
throw new Error("render failed");
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
      const p = Bun.spawnSync([...CLI, "add", "--command", command], {
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

  /**
   * Start `search --query git` in a hidden console, stdout/stderr to files.
   * `before` lines run first in the same console (e.g. `mode con:`), and
   * `after` lines once the search has exited.
   */
  function startSearch(before: string[] = [], after: string[] = []): number {
    const run = `@${CLI.map((a) => `"${a}"`).join(" ")} search --query git > "${file("selected.txt")}" 2> "${file("err.txt")}"`;
    writeFileSync(file("run.cmd"), [...before, run, ...after].join("\r\n") + "\r\n");
    pid = startHiddenConsole("cmd.exe", ["/c", file("run.cmd")], env);
    return pid;
  }

  /** Run `command` (default: the search) under MODES_WRAPPER. */
  function startRecordingModes(command: string[] = [...CLI, "search", "--query", "git"]): number {
    writeFileSync(file("wrapper.ts"), MODES_WRAPPER);
    const wrapperArgs = [file("wrapper.ts"), file("selected.txt"), file("err.txt"), file("modes.txt")];
    pid = startHiddenConsole(process.execPath, [...wrapperArgs, ...command], env);
    return pid;
  }

  function recordedModes(): { before: string; after: string; exitCode: string } {
    const [before, after, exitCode] = read("modes.txt").split("\n");
    return { before, after, exitCode };
  }

  /** The console process is gone, so afterEach must not taskkill its pid. */
  function expectExited(p: number): void {
    expect(waitForExit(p)).toBe(true);
    pid = null;
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

  // 80 columns: the driver reads a console narrower than its 120-column cap.
  // 120 columns: the frame follows the real width, not the 80-column fallback.
  test.each([80, 120])("lists matching history and prints the row chosen with Down + Enter at %p columns", (cols) => {
    const p = startSearch([`@mode con: cols=${cols} lines=30`]);
    const screens = driveSearch(p, [
      { type: "waitFor", text: "git stash pop", timeoutMs: 10_000 },
      { type: "screen", label: "open" },
      { type: "key", value: "down" },
      { type: "waitForChange" },
      { type: "screen", label: "moved" },
      { type: "key", value: "enter" },
    ]);
    expectExited(p);

    const open = screen(screens, "open");
    expect(open.some((l) => l.includes("git status"))).toBe(true);
    expect(open.some((l) => l.includes("git stash pop"))).toBe(true);
    expect(open.some((l) => l.includes("docker ps"))).toBe(false);
    // Box-drawing glyphs arrive intact (UTF-8 output is decoded as Unicode),
    // and both separators span exactly the console's width.
    expect(open.filter((l) => /^─+$/.test(l))).toEqual(["─".repeat(cols), "─".repeat(cols)]);

    const first = selectedCommand(open);
    const moved = selectedCommand(screen(screens, "moved"));
    expect(GIT_COMMANDS).toContain(first!);
    expect(GIT_COMMANDS).toContain(moved!);
    expect(moved).not.toBe(first);

    expect(read("selected.txt")).toBe(moved!);
    expect(read("err.txt")).toBe("");
  }, TEST_TIMEOUT_MS);

  test("redraws in place under earlier output and leaves that output intact", () => {
    const markers = Array.from({ length: 10 }, (_, i) => `marker ${i + 1}`);
    // 10 marker rows + the 19-row frame fit a 30-row console without scrolling;
    // `pause` keeps the console open after the CLI exits, to read it once more.
    const p = startSearch(["@mode con: cols=120 lines=30", ...markers.map((m) => `@echo ${m}`)], ["@pause >nul"]);
    const redraws = ["open", "down 1", "down 2", "down 3", "typed"];
    const screens = driveSearch(p, [
      { type: "waitFor", text: "git stash pop", timeoutMs: 10_000 },
      { type: "screen", label: "open" },
      ...[1, 2, 3].flatMap((n): Step[] => [
        { type: "key", value: "down" },
        { type: "waitForChange" },
        { type: "screen", label: `down ${n}` },
      ]),
      { type: "text", value: "s" },
      { type: "waitForChange" },
      { type: "screen", label: "typed" },
      { type: "key", value: "enter" },
      { type: "waitForChange" },
      { type: "screen", label: "after" },
    ]);
    const rows = (label: string) => screens.find((s) => s.label === label)!.rows;

    for (const label of redraws) {
      const r = rows(label);
      // The output above the frame is untouched...
      expect(r.slice(0, 10)).toEqual(markers);
      // ...the frame starts right under it, on the same row every time...
      expect(r.findIndex((row) => /^\s*> gits?$/.test(row))).toBe(10);
      // ...and the search box starts at column 1, with no drift.
      expect(r[10]).toMatch(/^> gits?$/);
      expect(r[11]).toBe("─".repeat(120));
    }
    // Enter wipes the frame and only the frame.
    expect(rows("after").slice(0, 10)).toEqual(markers);
    expect(rows("after").slice(10).filter((row) => row !== "")).toEqual([]);
    expect(read("err.txt")).toBe("");
  }, TEST_TIMEOUT_MS);

  test("Escape cancels without printing anything", () => {
    const p = startSearch();
    driveSearch(p, [
      { type: "waitFor", text: "git stash pop", timeoutMs: 10_000 },
      { type: "key", value: "escape" },
    ]);
    expectExited(p);

    expect(read("selected.txt")).toBe("");
    expect(read("err.txt")).toBe("");
  }, TEST_TIMEOUT_MS);

  test.each(["enter", "escape", "ctrl-c"] as KeyName[])("leaves the console modes as it found them after %s", (key) => {
    const p = startRecordingModes();
    driveSearch(p, [
      { type: "waitFor", text: "git stash pop", timeoutMs: 10_000 },
      { type: "key", value: key },
    ]);
    expectExited(p);

    const { before, after, exitCode } = recordedModes();
    expect(before).toMatch(/^[0-9a-f]+ [0-9a-f]+$/);
    expect(after).toBe(before);
    expect(exitCode).toBe("0");
    expect(read("err.txt")).toBe("");
  }, TEST_TIMEOUT_MS);

  test("survives Ctrl+Break and still leaves the console modes as it found them", () => {
    const p = startRecordingModes();
    driveSearch(p, [
      { type: "waitFor", text: "git stash pop", timeoutMs: 10_000 },
      { type: "key", value: "ctrl-break" },
      // Still reading keys: the query becomes "gitx", which matches nothing.
      { type: "text", value: "x" },
      { type: "waitFor", text: "No matches found" },
      { type: "key", value: "escape" },
    ]);
    expectExited(p);

    const { before, after, exitCode } = recordedModes();
    expect(after).toBe(before);
    expect(exitCode).toBe("0");
    expect(read("err.txt")).toBe("");
  }, TEST_TIMEOUT_MS);

  test("restores the console modes when an error skips the caller's cleanup", () => {
    writeFileSync(file("throw.ts"), THROW_AFTER_RAW);
    const p = startRecordingModes([process.execPath, file("throw.ts")]);
    expectExited(p);

    const { before, after, exitCode } = recordedModes();
    expect(read("err.txt")).toContain("render failed");
    expect(exitCode).toBe("1");
    expect(after).toBe(before);
  }, TEST_TIMEOUT_MS);
});
