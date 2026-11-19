import type { Tty } from "./types";
import { createPosixTty } from "./posix";

export type { Tty } from "./types";

let tty: Tty | null = null;

export function getTty(): Tty {
  if (tty === null) {
    if (process.platform === "win32") {
      // Required here, not imported at the top: loading windows.ts dlopens
      // kernel32.dll, which must never happen on POSIX.
      const { createWindowsTty } = require("./windows") as typeof import("./windows");
      tty = createWindowsTty();
    } else {
      tty = createPosixTty();
    }
  }
  return tty;
}
