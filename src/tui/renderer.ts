import { getTty } from "./tty";

const ESC = "\x1b[";

export function closeTty(): void {
  getTty().close();
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
  return getTty().getTerminalSize();
}

export function write(text: string): void {
  getTty().write(text);
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, maxWidth - 1) + "…";
}
