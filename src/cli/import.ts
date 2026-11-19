import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { insertCommand, getExistingHashes, hashCommand } from "../db/queries";
import { getHostname } from "../utils/platform";

export function runImport(shell?: string): void {
  const home = homedir();
  const existing = getExistingHashes();
  const seen = new Set<string>();
  let imported = 0;
  let skipped = 0;

  if (!shell || shell === "zsh") {
    const zshPath = join(home, ".zsh_history");
    if (existsSync(zshPath)) {
      const result = importZshHistory(zshPath, existing, seen);
      imported += result.imported;
      skipped += result.skipped;
    }
  }

  if (!shell || shell === "bash") {
    const bashPath = join(home, ".bash_history");
    if (existsSync(bashPath)) {
      const result = importBashHistory(bashPath, existing, seen);
      imported += result.imported;
      skipped += result.skipped;
    }
  }

  if (!shell || shell === "fish") {
    const fishPath = join(home, ".local", "share", "fish", "fish_history");
    if (existsSync(fishPath)) {
      const result = importFishHistory(fishPath, existing, seen);
      imported += result.imported;
      skipped += result.skipped;
    }
  }

  if (!shell || shell === "powershell") {
    const paths = powerShellHistoryPaths({
      platform: process.platform,
      home,
      appData: process.env.APPDATA,
    });
    for (const psPath of paths) {
      if (!existsSync(psPath)) continue;
      const result = importPowerShellHistory(psPath, existing, seen);
      imported += result.imported;
      skipped += result.skipped;
    }
  }

  console.log(`Imported ${imported} commands. Skipped ${skipped} duplicates.`);
}

/** Where PSReadLine keeps ConsoleHost_history.txt for the given platform. */
export function powerShellHistoryPaths(env: {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
}): string[] {
  if (env.platform === "win32") {
    const appData = env.appData || join(env.home, "AppData", "Roaming");
    return [
      join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
    ];
  }
  return [join(env.home, ".local", "share", "powershell", "PSReadLine", "ConsoleHost_history.txt")];
}

interface ImportResult {
  imported: number;
  skipped: number;
}

function tryInsert(
  cmd: string,
  shell: string,
  hostname: string,
  existing: Set<string>,
  seen: Set<string>
): boolean {
  const hash = hashCommand(cmd);
  if (existing.has(hash) || seen.has(hash)) return false;
  seen.add(hash);
  insertCommand({ command: cmd, hostname, shell });
  return true;
}

function importZshHistory(
  path: string,
  existing: Set<string>,
  seen: Set<string>
): ImportResult {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  let imported = 0;
  let skipped = 0;
  const hostname = getHostname();

  for (const line of lines) {
    // zsh extended format: : timestamp:0;command
    const extMatch = line.match(/^: (\d+):\d+;(.+)$/);
    if (extMatch) {
      const cmd = extMatch[2].trim();
      if (cmd && cmd.length >= 2) {
        if (tryInsert(cmd, "zsh", hostname, existing, seen)) {
          imported++;
        } else {
          skipped++;
        }
      }
      continue;
    }

    // Plain format
    const cmd = line.trim();
    if (cmd && cmd.length >= 2 && !cmd.startsWith("#")) {
      if (tryInsert(cmd, "zsh", hostname, existing, seen)) {
        imported++;
      } else {
        skipped++;
      }
    }
  }

  return { imported, skipped };
}

/**
 * fish_history is YAML-ish, one entry per command:
 *   - cmd: git status
 *     when: 1785748447
 * fish escapes backslash as `\\` and newline as `\n`; nothing else needs
 * decoding, so this stays a line scanner rather than a YAML parser.
 */
export function importFishHistory(
  path: string,
  existing: Set<string>,
  seen: Set<string>
): ImportResult {
  const content = readFileSync(path, "utf-8");
  let imported = 0;
  let skipped = 0;
  const hostname = getHostname();

  for (const line of content.split("\n")) {
    const match = line.match(/^- cmd: (.+)$/);
    if (!match) continue;

    const cmd = match[1].replace(/\\n/g, "\n").replace(/\\\\/g, "\\").trim();
    if (cmd.length < 2) continue;

    if (tryInsert(cmd, "fish", hostname, existing, seen)) {
      imported++;
    } else {
      skipped++;
    }
  }

  return { imported, skipped };
}

export interface PowerShellImportResult extends ImportResult {
  /** Multi-line entries left out; counted separately, never as duplicates. */
  multiline: number;
}

/** Decode a history file as UTF-8, or UTF-16 LE/BE when a BOM says so. */
function decodeHistory(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2, 2 + ((buf.length - 2) & ~1));
    return Buffer.from(body).swap16().toString("utf16le");
  }
  // trim() would also drop a BOM, so this is belt and braces rather than load-bearing.
  const text = buf.toString("utf-8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * ConsoleHost_history.txt: PSReadLine writes a backtick before every newline
 * *inside* a history entry and its reader strips exactly one, so a trailing
 * backtick is the file format's "entry continues" marker, not typed text (a
 * typed continuation backtick is written as two). Entries are grouped the way
 * the reader does it. Only single-line entries are imported: a multi-line
 * entry cannot be stored faithfully (insertCommand flattens newlines) and the
 * live PowerShell hook does not capture them either. Those are reported in
 * `multiline`, and an unterminated tail at end of file is dropped, as
 * PSReadLine does.
 */
export function importPowerShellHistory(
  path: string,
  existing: Set<string>,
  seen: Set<string>
): PowerShellImportResult {
  const lines = decodeHistory(readFileSync(path)).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let imported = 0;
  let skipped = 0;
  let multiline = 0;
  const hostname = getHostname();
  let entryLines = 0;
  let first = "";

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (entryLines === 0) first = line;
    entryLines++;
    if (line.endsWith("`")) continue;

    if (entryLines > 1) {
      multiline++;
    } else {
      // Hash what insertCommand will store (control chars -> space, trimmed):
      // hashing the raw text would never match the DB and re-import every run.
      const cmd = first.replace(/[\x00-\x1f\x7f]/g, " ").trim();
      if (cmd.length >= 2 && cmd.length <= 8192) {
        if (tryInsert(cmd, "powershell", hostname, existing, seen)) {
          imported++;
        } else {
          skipped++;
        }
      }
    }
    entryLines = 0;
  }

  return { imported, skipped, multiline };
}

function importBashHistory(
  path: string,
  existing: Set<string>,
  seen: Set<string>
): ImportResult {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  let imported = 0;
  let skipped = 0;
  const hostname = getHostname();

  for (const line of lines) {
    const cmd = line.trim();
    if (cmd && cmd.length >= 2 && !cmd.startsWith("#")) {
      if (tryInsert(cmd, "bash", hostname, existing, seen)) {
        imported++;
      } else {
        skipped++;
      }
    }
  }

  return { imported, skipped };
}
