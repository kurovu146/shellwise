import { openSync, readSync, writeSync, closeSync } from "fs";
import { execSync } from "child_process";
import type { Tty } from "./types";

export function createPosixTty(): Tty {
  // Use /dev/tty directly — avoids Bun kqueue bug with process.stdin
  // inside $() capture from shell integration
  let ttyReadFd: number | null = null;

  // Open /dev/tty directly — avoids Bun bug where process.stderr is
  // undefined when fd 2 is redirected to /dev/tty via shell integration
  let ttyFd: number | null = null;

  function getTtyReadFd(): number {
    if (ttyReadFd === null) {
      ttyReadFd = openSync("/dev/tty", "r");
    }
    return ttyReadFd;
  }

  function getTtyFd(): number {
    if (ttyFd === null) {
      ttyFd = openSync("/dev/tty", "w");
    }
    return ttyFd;
  }

  return {
    readKeypress(): Buffer {
      // Large enough to hold a pasted chunk in one read; a 16-byte buffer split
      // multi-byte UTF-8 (emoji, accented chars) across reads and corrupted them.
      const buf = Buffer.alloc(4096);
      const bytesRead = readSync(getTtyReadFd(), buf);
      return buf.subarray(0, bytesRead);
    },

    write(text: string): void {
      writeSync(getTtyFd(), text);
    },

    enableRawMode(): void {
      try {
        execSync("stty raw -echo </dev/tty", { stdio: "ignore" });
      } catch {}
    },

    disableRawMode(): void {
      try {
        execSync("stty -raw echo </dev/tty", { stdio: "ignore" });
      } catch {}
    },

    getTerminalSize(): { rows: number; cols: number } {
      // Avoid process.stdout/stderr entirely — Bun crashes with kqueue error
      // when they're accessed inside $() capture. Use stty instead.
      try {
        const output = execSync("stty size </dev/tty", { encoding: "utf-8" }).trim();
        const [rows, cols] = output.split(" ").map(Number);
        if (rows > 0 && cols > 0) return { rows, cols };
      } catch {}
      return { rows: 24, cols: 80 };
    },

    close(): void {
      if (ttyReadFd !== null) {
        try { closeSync(ttyReadFd); } catch {}
        ttyReadFd = null;
      }
      if (ttyFd !== null) {
        try { closeSync(ttyFd); } catch {}
        ttyFd = null;
      }
    },
  };
}
