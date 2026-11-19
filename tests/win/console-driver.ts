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

export type KeyName = "tab" | "shift-tab" | "enter" | "escape" | "up" | "down" | "ctrl-r" | "ctrl-c";

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
}

type KeyEvent = { vk: number; ch: number; flags?: number };

const KEYS: Record<KeyName, KeyEvent> = {
  tab: { vk: 9, ch: 9 },
  "shift-tab": { vk: 9, ch: 9, flags: 0x10 }, // SHIFT_PRESSED
  enter: { vk: 13, ch: 13 },
  escape: { vk: 27, ch: 27 },
  up: { vk: 0x26, ch: 0, flags: 0x100 }, // ENHANCED_KEY
  down: { vk: 0x28, ch: 0, flags: 0x100 },
  "ctrl-r": { vk: 0x52, ch: 0x12, flags: 0x08 }, // LEFT_CTRL_PRESSED
  "ctrl-c": { vk: 0x43, ch: 0x03, flags: 0x08 },
};

const ROWS = 30;
const COLS = 120;
const DEFAULT_TIMEOUT_MS = 5000;
const POLL_MS = 50;
const ATTACH_TIMEOUT_MS = 3000;
const INVALID_HANDLE = 0xffffffffffffffffn;

function main(): void {
  const pid = Number(process.argv[2]);
  const steps = JSON.parse(readFileSync(process.argv[3], "utf8")) as Step[];

  const k = dlopen("kernel32.dll", {
    FreeConsole: { args: [], returns: "i32" },
    AttachConsole: { args: ["u32"], returns: "i32" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    WriteConsoleInputW: { args: ["u64", "ptr", "u32", "ptr"], returns: "i32" },
    ReadConsoleOutputCharacterW: { args: ["u64", "ptr", "u32", "u32", "ptr"], returns: "i32" },
    GetConsoleScreenBufferInfo: { args: ["u64", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols;

  k.FreeConsole();
  // The target's console host may still be starting right after Start-Process.
  const attachDeadline = Date.now() + ATTACH_TIMEOUT_MS;
  while (!k.AttachConsole(pid)) {
    if (Date.now() > attachDeadline) fail(`AttachConsole(${pid}) failed: error ${k.GetLastError()}`);
    Bun.sleepSync(POLL_MS);
  }

  const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
  const GENERIC_RW = (0x80000000 | 0x40000000) >>> 0;
  const openConsole = (name: string) => {
    const h = k.CreateFileW(wide(name), GENERIC_RW, 3, null, 3, 0, 0n);
    if (BigInt(h) === INVALID_HANDLE) fail(`CreateFileW(${name}) failed: error ${k.GetLastError()}`);
    return h;
  };
  const hIn = openConsole("CONIN$");
  const hOut = openConsole("CONOUT$");

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
  function windowTop(): number {
    const info = new Uint8Array(22);
    if (!k.GetConsoleScreenBufferInfo(hOut, info)) return 0;
    return new DataView(info.buffer).getInt16(12, true); // srWindow.Top
  }

  function readScreen(): string[] {
    const lines: string[] = [];
    const buf = Buffer.alloc(COLS * 2);
    const n = new Uint32Array(1);
    const top = windowTop();
    for (let y = top; y < top + ROWS; y++) {
      // COORD passed by value: X in the low word, Y in the high word.
      k.ReadConsoleOutputCharacterW(hOut, buf, COLS, (y << 16) >>> 0, n);
      const line = buf.toString("utf16le", 0, n[0] * 2).trimEnd();
      if (line) lines.push(line);
    }
    return lines;
  }

  const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

  // Poll until `done` holds and two reads POLL_MS apart agree, so a frame that
  // is still being painted is never captured.
  function pollUntil(done: (lines: string[]) => boolean, timeoutMs: number, what: string): void {
    const deadline = Date.now() + timeoutMs;
    let prev: string[] | null = null;
    while (true) {
      const lines = readScreen();
      if (done(lines) && prev !== null && same(prev, lines)) return;
      prev = lines;
      if (Date.now() > deadline) {
        fail(`timed out after ${timeoutMs}ms waiting for ${what}; last screen:\n${lines.join("\n")}`);
      }
      Bun.sleepSync(POLL_MS);
    }
  }

  const screens: Screen[] = [];
  let lastCaptured: string[] = readScreen();

  for (const step of steps) {
    switch (step.type) {
      case "text":
        send([...step.value].map((c) => ({
          vk: /[a-z]/i.test(c) ? c.toUpperCase().charCodeAt(0) : 0,
          ch: c.charCodeAt(0),
        })));
        break;
      case "key":
        send([KEYS[step.value]]);
        break;
      case "wait":
        Bun.sleepSync(step.ms);
        break;
      case "screen":
        lastCaptured = readScreen();
        screens.push({ label: step.label, lines: lastCaptured });
        break;
      case "waitFor":
        pollUntil(
          (lines) => lines.some((l) => l.includes(step.text)),
          step.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          JSON.stringify(step.text)
        );
        break;
      case "waitForChange": {
        const before = lastCaptured;
        pollUntil((lines) => !same(lines, before), step.timeoutMs ?? DEFAULT_TIMEOUT_MS, "the screen to change");
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

if (import.meta.main) main();
