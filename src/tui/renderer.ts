import { openSync, writeSync, closeSync } from "fs";
import { execSync } from "child_process";

const ESC = "\x1b[";

// Open /dev/tty directly — avoids Bun bug where process.stderr is
// undefined when fd 2 is redirected to /dev/tty via shell integration
let ttyFd: number | null = null;

function getTtyFd(): number {
  if (ttyFd === null) {
    ttyFd = openSync("/dev/tty", "w");
  }
  return ttyFd;
}

export function closeTty(): void {
  if (ttyFd !== null) {
    try { closeSync(ttyFd); } catch {}
    ttyFd = null;
  }
}

export function moveCursorUp(n: number): string {
  return n > 0 ? `${ESC}${n}A` : "";
}

export function moveCursorDown(n: number): string {
  return n > 0 ? `${ESC}${n}B` : "";
}

export function moveCursorToColumn(col: number): string {
  return `${ESC}${col}G`;
}

export function clearLine(): string {
  return `${ESC}2K`;
}

export function clearDown(): string {
  return `${ESC}J`;
}

export function hideCursor(): string {
  return `${ESC}?25l`;
}

export function showCursor(): string {
  return `${ESC}?25h`;
}

export function getTerminalSize(): { rows: number; cols: number } {
  // Avoid process.stdout/stderr entirely — Bun crashes with kqueue error
  // when they're accessed inside $() capture. Use stty instead.
  try {
    const output = execSync("stty size </dev/tty", { encoding: "utf-8" }).trim();
    const [rows, cols] = output.split(" ").map(Number);
    if (rows > 0 && cols > 0) return { rows, cols };
  } catch {}
  return { rows: 24, cols: 80 };
}

export function write(text: string): void {
  writeSync(getTtyFd(), text);
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, maxWidth - 1) + "…";
}
