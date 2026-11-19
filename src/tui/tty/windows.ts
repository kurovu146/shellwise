import { dlopen } from "bun:ffi";
import { openSync, readSync, writeSync, closeSync } from "fs";
import type { Tty } from "./types";

// Windows has no /dev/tty or stty. CONIN$/CONOUT$ always name the attached
// console, even while stdout is redirected to the calling shell's capture,
// and the console API switches it to raw VT input/output. Only loaded on
// win32 (see ./index.ts): importing this module dlopens kernel32.dll.

const ENABLE_PROCESSED_OUTPUT = 0x0001;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
// Raw input: no line buffering, echo or Ctrl+C signal (it arrives as 0x03),
// and keys come in as the same VT sequences a POSIX terminal sends.
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

const GENERIC_READ_WRITE = (0x80000000 | 0x40000000) >>> 0;
const FILE_SHARE_READ_WRITE = 3;
const OPEN_EXISTING = 3;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;

const k = dlopen("kernel32.dll", {
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
  GetConsoleMode: { args: ["u64", "ptr"], returns: "i32" },
  SetConsoleMode: { args: ["u64", "u32"], returns: "i32" },
  GetConsoleScreenBufferInfo: { args: ["u64", "ptr"], returns: "i32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
}).symbols;

interface Console {
  // Handles for mode and size control; the fds carry the actual bytes.
  hIn: bigint;
  hOut: bigint;
  inFd: number;
  outFd: number;
  // null when the mode could not be read, so there is nothing to restore.
  origIn: number | null;
  origOut: number | null;
}

function openHandle(name: string): bigint {
  const h = BigInt(k.CreateFileW(
    Buffer.from(name + "\0", "utf16le"),
    GENERIC_READ_WRITE,
    FILE_SHARE_READ_WRITE,
    null,
    OPEN_EXISTING,
    0,
    0n
  ));
  if (h === INVALID_HANDLE_VALUE) throw new Error(`cannot open console ${name}`);
  return h;
}

function getMode(h: bigint): number | null {
  const mode = new Uint32Array(1);
  return k.GetConsoleMode(h, mode) ? mode[0] : null;
}

function closeHandle(h: bigint | null): void {
  try {
    if (h !== null) k.CloseHandle(h);
  } catch {}
}

function closeFd(fd: number | null): void {
  try {
    if (fd !== null) closeSync(fd);
  } catch {}
}

export function createWindowsTty(): Tty {
  let con: Console | null = null;

  function open(): Console {
    if (con !== null) return con;

    let hIn: bigint | null = null;
    let hOut: bigint | null = null;
    let inFd: number | null = null;
    let outFd: number | null = null;
    try {
      hIn = openHandle("CONIN$");
      hOut = openHandle("CONOUT$");
      inFd = openSync("CONIN$", "r");
      outFd = openSync("CONOUT$", "w");
    } catch (e) {
      closeFd(inFd);
      closeFd(outFd);
      closeHandle(hIn);
      closeHandle(hOut);
      throw e;
    }

    const opened: Console = { hIn, hOut, inFd, outFd, origIn: getMode(hIn), origOut: getMode(hOut) };
    // Output stays in VT mode until close(): every frame is ANSI escapes.
    if (opened.origOut !== null) {
      k.SetConsoleMode(hOut, opened.origOut | ENABLE_VIRTUAL_TERMINAL_PROCESSING | ENABLE_PROCESSED_OUTPUT);
    }
    con = opened;
    return con;
  }

  return {
    readKeypress(): Buffer {
      // Same size as the POSIX backend: a whole pasted chunk in one read.
      const buf = Buffer.alloc(4096);
      const bytesRead = readSync(open().inFd, buf);
      return buf.subarray(0, bytesRead);
    },

    write(text: string): void {
      writeSync(open().outFd, text);
    },

    enableRawMode(): void {
      // Best effort like `stty raw`: if the console cannot be opened, the
      // first write() reports it.
      try {
        k.SetConsoleMode(open().hIn, ENABLE_VIRTUAL_TERMINAL_INPUT);
      } catch {}
    },

    disableRawMode(): void {
      try {
        if (con !== null && con.origIn !== null) k.SetConsoleMode(con.hIn, con.origIn);
      } catch {}
    },

    getTerminalSize(): { rows: number; cols: number } {
      try {
        // CONSOLE_SCREEN_BUFFER_INFO is 22 bytes; srWindow (the visible
        // window, not the scrollback buffer) is Left@10 Top@12 Right@14 Bottom@16.
        const info = new Uint8Array(22);
        if (k.GetConsoleScreenBufferInfo(open().hOut, info)) {
          const v = new DataView(info.buffer);
          const cols = v.getInt16(14, true) - v.getInt16(10, true) + 1;
          const rows = v.getInt16(16, true) - v.getInt16(12, true) + 1;
          if (rows > 0 && cols > 0) return { rows, cols };
        }
      } catch {}
      return { rows: 24, cols: 80 };
    },

    close(): void {
      if (con === null) return;
      const c = con;
      con = null;
      try {
        if (c.origIn !== null) k.SetConsoleMode(c.hIn, c.origIn);
      } catch {}
      try {
        if (c.origOut !== null) k.SetConsoleMode(c.hOut, c.origOut);
      } catch {}
      closeFd(c.inFd);
      closeFd(c.outFd);
      closeHandle(c.hIn);
      closeHandle(c.hOut);
    },
  };
}
