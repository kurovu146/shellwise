import { dlopen } from "bun:ffi";

// NtQueryInformationProcess(ProcessHandleInformation): a snapshot of this
// process's own handle table (Windows 8+).
const PROCESS_HANDLE_INFORMATION = 51;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004 | 0;
// PROCESS_HANDLE_SNAPSHOT_INFORMATION on x64: NumberOfHandles and Reserved
// (8 bytes each), then 40-byte entries with HandleValue at 0 and
// HandleAttributes at 32.
const HEADER_BYTES = 16;
const ENTRY_BYTES = 40;
const ATTRIBUTES_OFFSET = 32;
const OBJ_INHERIT = 0x2;
const HANDLE_FLAG_INHERIT = 0x1;
const CURRENT_PROCESS = -1n;

/**
 * Windows: make every handle this process holds non-inheritable, so a child
 * started afterwards gets only the handles its spawn sets up.
 *
 * Needed before starting the detached daemon. A parent that launches
 * `daemon start` through CreateProcess (PowerShell's ProcessStartInfo, cmd.exe)
 * passes every inheritable handle it owns, its own stdout pipe included, and
 * not as our std handles (those Bun already keeps to itself) but as plain
 * entries in our handle table. The daemon would inherit them in turn and keep
 * the caller's pipe open until it stops, so a caller reading that output to
 * EOF would hang. No-op elsewhere; failures are ignored, as before this the
 * handles were simply inherited.
 */
export function stopHandleInheritance(): void {
  if (process.platform !== "win32") return;
  try {
    const nt = dlopen("ntdll.dll", {
      NtQueryInformationProcess: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    }).symbols;
    const k = dlopen("kernel32.dll", {
      SetHandleInformation: { args: ["u64", "u32", "u32"], returns: "i32" },
    }).symbols;

    const needed = new Uint32Array(1);
    let buf = new Uint8Array(16 * 1024);
    let status = nt.NtQueryInformationProcess(CURRENT_PROCESS, PROCESS_HANDLE_INFORMATION, buf, buf.length, needed);
    // The table can grow between the two calls: retry with headroom.
    for (let i = 0; status === STATUS_INFO_LENGTH_MISMATCH && i < 3; i++) {
      buf = new Uint8Array(needed[0] + 4096);
      status = nt.NtQueryInformationProcess(CURRENT_PROCESS, PROCESS_HANDLE_INFORMATION, buf, buf.length, needed);
    }
    if (status !== 0) return;

    const view = new DataView(buf.buffer);
    const count = Number(view.getBigUint64(0, true));
    for (let i = 0; i < count; i++) {
      const entry = HEADER_BYTES + i * ENTRY_BYTES;
      if (!(view.getUint32(entry + ATTRIBUTES_OFFSET, true) & OBJ_INHERIT)) continue;
      k.SetHandleInformation(view.getBigUint64(entry, true), HANDLE_FLAG_INHERIT, 0);
    }
  } catch {}
}
