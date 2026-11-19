/**
 * Terminal access for the interactive TUI. The TUI draws on the terminal while
 * stdout is captured by the calling shell, so it never touches process.stdout;
 * each platform backend talks to the controlling terminal directly.
 */
export interface Tty {
  readKeypress(): Buffer;          // blocking; up to 4096 bytes
  write(text: string): void;
  enableRawMode(): void;
  disableRawMode(): void;
  getTerminalSize(): { rows: number; cols: number };
  close(): void;                   // idempotent; restores anything changed
}
