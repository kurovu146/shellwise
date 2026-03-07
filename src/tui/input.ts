import { openSync, readSync, closeSync } from "fs";
import { execSync } from "child_process";

export type KeyEvent =
  | { type: "char"; char: string }
  | { type: "special"; key: SpecialKey }
  | { type: "ctrl"; char: string };

export type SpecialKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "tab"
  | "shift-tab"
  | "enter"
  | "escape"
  | "backspace"
  | "delete"
  | "home"
  | "end";

export function parseKeypress(data: Buffer): KeyEvent {
  const str = data.toString("utf-8");

  // Ctrl combinations
  if (data.length === 1 && data[0] < 32) {
    const char = data[0];
    if (char === 13) return { type: "special", key: "enter" };
    if (char === 9) return { type: "special", key: "tab" };
    if (char === 27) return { type: "special", key: "escape" };
    if (char === 127) return { type: "special", key: "backspace" };
    // Ctrl+A = 1, Ctrl+B = 2, etc.
    return { type: "ctrl", char: String.fromCharCode(char + 96) };
  }

  // Escape sequences
  if (str.startsWith("\x1b[")) {
    const seq = str.slice(2);
    if (seq === "A") return { type: "special", key: "up" };
    if (seq === "B") return { type: "special", key: "down" };
    if (seq === "C") return { type: "special", key: "right" };
    if (seq === "D") return { type: "special", key: "left" };
    if (seq === "H") return { type: "special", key: "home" };
    if (seq === "F") return { type: "special", key: "end" };
    if (seq === "Z") return { type: "special", key: "shift-tab" };
    if (seq === "3~") return { type: "special", key: "delete" };
  }

  // Escape only
  if (data.length === 1 && data[0] === 27) {
    return { type: "special", key: "escape" };
  }

  // Regular character
  return { type: "char", char: str };
}

// Use /dev/tty directly — avoids Bun kqueue bug with process.stdin
// inside $() capture from shell integration
let ttyReadFd: number | null = null;

function getTtyReadFd(): number {
  if (ttyReadFd === null) {
    ttyReadFd = openSync("/dev/tty", "r");
  }
  return ttyReadFd;
}

export function readKeypress(): Buffer {
  const buf = Buffer.alloc(16);
  const bytesRead = readSync(getTtyReadFd(), buf);
  return buf.subarray(0, bytesRead);
}

export function enableRawMode(): void {
  try {
    execSync("stty raw -echo </dev/tty", { stdio: "ignore" });
  } catch {}
}

export function disableRawMode(): void {
  try {
    execSync("stty -raw echo </dev/tty", { stdio: "ignore" });
  } catch {}
}

export function closeTtyInput(): void {
  if (ttyReadFd !== null) {
    try { closeSync(ttyReadFd); } catch {}
    ttyReadFd = null;
  }
}
