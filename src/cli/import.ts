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

/**
 * ConsoleHost_history.txt holds one command per line; a multi-line command is
 * written with a trailing backtick on every line but the last. The file is
 * UTF-8 and Windows PowerShell 5.1 may prefix a BOM, which would otherwise
 * stick to the first command.
 */
export function importPowerShellHistory(
  path: string,
  existing: Set<string>,
  seen: Set<string>
): ImportResult {
  const content = readFileSync(path, "utf-8").replace(/^﻿/, "");
  let imported = 0;
  let skipped = 0;
  const hostname = getHostname();
  let pending: string[] = [];

  const flush = (): void => {
    const cmd = pending.join("\n").trim();
    pending = [];
    if (cmd.length < 2) return;
    if (tryInsert(cmd, "powershell", hostname, existing, seen)) {
      imported++;
    } else {
      skipped++;
    }
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    pending.push(line);
    if (!line.endsWith("`")) flush();
  }
  // A file may end in the middle of a continuation.
  if (pending.length > 0) flush();

  return { imported, skipped };
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
