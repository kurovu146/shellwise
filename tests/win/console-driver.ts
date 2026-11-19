// Drives a TUI running in another process's (hidden) Windows console: attaches
// to that console, injects key events and reads back the screen buffer.
//
// Run as a subprocess (importing it only yields the Step/Screen types):
//   bun tests/win/console-driver.ts <pid> <steps.json>
// Prints a JSON array of Screen to stdout. A waitFor/waitForChange step that
// times out exits 1 with the last screen on stderr.
//
// It must be its own process because AttachConsole needs the caller to give
// up its current console first (FreeConsole), which the test runner cannot do.
import { dlopen } from "bun:ffi";
import { readFileSync, writeSync } from "fs";

// "ctrl-break" is a console control event, not an input record: see ctrlBreak().
export type KeyName = keyof typeof KEYS | "ctrl-break";

export type Step =
  | { type: "text"; value: string }
  | { type: "key"; value: KeyName }
  | { type: "wait"; ms: number }
  | { type: "screen"; label: string }
  // Poll until some row contains `text` and the screen has stopped changing.
  | { type: "waitFor"; text: string; timeoutMs?: number }
  // Poll until the screen differs from the last captured `screen` step and has
  // stopped changing — for keys whose effect has no fixed text (moving a cursor).
  | { type: "waitForChange"; timeoutMs?: number };

export interface Screen {
  label: string;
  lines: string[];
  // Every row of the window, blank ones kept, so a test can check where
  // something sits on screen (`lines` drops blank rows and loses that).
  rows: string[];
}

type KeyEvent = { vk: number; ch: number; flags?: number };

const KEYS = {
  tab: { vk: 9, ch: 9 },
  "shift-tab": { vk: 9, ch: 9, flags: 0x10 }, // SHIFT_PRESSED
  enter: { vk: 13, ch: 13 },
  escape: { vk: 27, ch: 27 },
  backspace: { vk: 8, ch: 8 },
  up: { vk: 0x26, ch: 0, flags: 0x100 }, // ENHANCED_KEY
  down: { vk: 0x28, ch: 0, flags: 0x100 },
  "ctrl-r": { vk: 0x52, ch: 0x12, flags: 0x08 }, // LEFT_CTRL_PRESSED
  "ctrl-c": { vk: 0x43, ch: 0x03, flags: 0x08 },
} satisfies Record<string, KeyEvent>;

const ROWS = 30;
// Upper bound only: a narrower console is read at its own buffer width, since
// a read past the end of a row runs on into the next one.
const MAX_COLS = 120;
const CTRL_BREAK_EVENT = 1;
const DEFAULT_TIMEOUT_MS = 5000;
const POLL_MS = 50;
const ATTACH_TIMEOUT_MS = 3000;
const INVALID_HANDLE = 0xffffffffffffffffn;

function kernel32() {
  return dlopen("kernel32.dll", {
    FreeConsole: { args: [], returns: "i32" },
    AttachConsole: { args: ["u32"], returns: "i32" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    WriteConsoleInputW: { args: ["u64", "ptr", "u32", "ptr"], returns: "i32" },
    ReadConsoleOutputCharacterW: { args: ["u64", "ptr", "u32", "u32", "ptr"], returns: "i32" },
    GetConsoleScreenBufferInfo: { args: ["u64", "ptr"], returns: "i32" },
    GenerateConsoleCtrlEvent: { args: ["u32", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols;
}

function attach(k: ReturnType<typeof kernel32>, pid: number): void {
  k.FreeConsole();
  // The target's console host may still be starting right after Start-Process.
  const deadline = Date.now() + ATTACH_TIMEOUT_MS;
  while (!k.AttachConsole(pid)) {
    if (Date.now() > deadline) fail(`AttachConsole(${pid}) failed: error ${k.GetLastError()}`);
    Bun.sleepSync(POLL_MS);
  }
}

// `console-driver.ts --ctrl-break <pid>`: raise Ctrl+Break on that console.
// Ctrl+Break stays a signal even in raw input mode, so it cannot be injected
// as an input record. GenerateConsoleCtrlEvent sends it to every process on
// the console, the caller included, and this helper normally dies of it; a
// Bun SIGBREAK listener did not keep the attached driver alive, which is why
// the driver detaches and delegates to this helper instead.
function ctrlBreak(pid: number): void {
  const k = kernel32();
  attach(k, pid);
  if (!k.GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0)) {
    fail(`GenerateConsoleCtrlEvent failed: error ${k.GetLastError()}`);
  }
  // Give the event time to arrive here too, then leave.
  Bun.sleepSync(1000);
}

function main(): void {
  const pid = Number(process.argv[2]);
  const steps = JSON.parse(readFileSync(process.argv[3], "utf8")) as Step[];
  const k = kernel32();
  attach(k, pid);

  const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
  const GENERIC_RW = (0x80000000 | 0x40000000) >>> 0;
  const openConsole = (name: string) => {
    const h = k.CreateFileW(wide(name), GENERIC_RW, 3, null, 3, 0, 0n);
    if (BigInt(h) === INVALID_HANDLE) fail(`CreateFileW(${name}) failed: error ${k.GetLastError()}`);
    return h;
  };
  let hIn = openConsole("CONIN$");
  let hOut = openConsole("CONOUT$");

  function send(keys: KeyEvent[]): void {
    // INPUT_RECORD is 20 bytes: EventType u16 @0, then KEY_EVENT_RECORD @4:
    // bKeyDown i32 @4, wRepeatCount @8, wVirtualKeyCode @10,
    // wVirtualScanCode @12, UnicodeChar @14, dwControlKeyState @16.
    const rec = Buffer.alloc(40 * keys.length);
    let o = 0;
    for (const key of keys)
      for (const down of [1, 0]) {
        rec.writeUInt16LE(1, o); // KEY_EVENT
        rec.writeInt32LE(down, o + 4);
        rec.writeUInt16LE(1, o + 8);
        rec.writeUInt16LE(key.vk, o + 10);
        rec.writeUInt16LE(key.ch, o + 14);
        rec.writeUInt32LE(key.flags ?? 0, o + 16);
        o += 20;
      }
    const n = new Uint32Array(1);
    if (!k.WriteConsoleInputW(hIn, rec, keys.length * 2, n)) {
      fail(`WriteConsoleInputW failed: error ${k.GetLastError()}`);
    }
  }

  // The scrollback buffer is far taller than the window, and the window
  // scrolls down once output passes its last row: read from the window's top.
  // CONSOLE_SCREEN_BUFFER_INFO: dwSize.X @0, srWindow.Top @12.
  function geometry(): { top: number; cols: number } {
    const info = new Uint8Array(22);
    if (!k.GetConsoleScreenBufferInfo(hOut, info)) fail(`GetConsoleScreenBufferInfo failed: error ${k.GetLastError()}`);
    const v = new DataView(info.buffer);
    return { top: v.getInt16(12, true), cols: Math.min(v.getInt16(0, true), MAX_COLS) };
  }

  // Every row of the window, right-trimmed, blank rows kept.
  function readRows(): string[] {
    const rows: string[] = [];
    const { top, cols } = geometry();
    const buf = Buffer.alloc(cols * 2);
    const n = new Uint32Array(1);
    for (let y = top; y < top + ROWS; y++) {
      // COORD passed by value: X in the low word, Y in the high word.
      k.ReadConsoleOutputCharacterW(hOut, buf, cols, (y << 16) >>> 0, n);
      rows.push(buf.toString("utf16le", 0, n[0] * 2).trimEnd());
    }
    return rows;
  }

  const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

  // Poll until `done` holds and two reads POLL_MS apart agree, so a frame that
  // is still being painted is never captured.
  function pollUntil(done: (rows: string[]) => boolean, timeoutMs: number, what: string): void {
    const deadline = Date.now() + timeoutMs;
    let prev: string[] | null = null;
    while (true) {
      const rows = readRows();
      if (done(rows) && prev !== null && same(prev, rows)) return;
      prev = rows;
      if (Date.now() > deadline) {
        fail(`timed out after ${timeoutMs}ms waiting for ${what}; last screen:\n${rows.join("\n")}`);
      }
      Bun.sleepSync(POLL_MS);
    }
  }

  const screens: Screen[] = [];
  let lastCaptured: string[] = readRows();

  for (const step of steps) {
    switch (step.type) {
      case "text":
        send([...step.value].map((c) => ({
          vk: /[a-z]/i.test(c) ? c.toUpperCase().charCodeAt(0) : 0,
          ch: c.charCodeAt(0),
        })));
        break;
      case "key":
        if (step.value === "ctrl-break") {
          k.CloseHandle(hIn);
          k.CloseHandle(hOut);
          k.FreeConsole();
          const helper = Bun.spawnSync([process.execPath, import.meta.path, "--ctrl-break", String(pid)], {
            windowsHide: true,
          });
          if (helper.exitCode === 1) fail(helper.stderr.toString());
          attach(k, pid);
          hIn = openConsole("CONIN$");
          hOut = openConsole("CONOUT$");
        } else {
          send([KEYS[step.value]]);
        }
        break;
      case "wait":
        Bun.sleepSync(step.ms);
        break;
      case "screen":
        lastCaptured = readRows();
        screens.push({ label: step.label, lines: lastCaptured.filter((r) => r !== ""), rows: lastCaptured });
        break;
      case "waitFor":
        pollUntil(
          (rows) => rows.some((r) => r.includes(step.text)),
          step.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          JSON.stringify(step.text)
        );
        break;
      case "waitForChange": {
        const before = lastCaptured;
        pollUntil((rows) => !same(rows, before), step.timeoutMs ?? DEFAULT_TIMEOUT_MS, "the screen to change");
        break;
      }
    }
  }

  k.CloseHandle(hIn);
  k.CloseHandle(hOut);
  k.FreeConsole();
  writeSync(1, JSON.stringify(screens));
}

function fail(message: string): never {
  writeSync(2, message + "\n");
  process.exit(1);
}

if (import.meta.main) {
  if (process.argv[2] === "--ctrl-break") ctrlBreak(Number(process.argv[3]));
  else main();
}
