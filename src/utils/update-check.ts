import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "./paths";
import { color } from "../tui/theme";

const CHECK_INTERVAL = 24 * 3600_000; // 1 day

interface CachedCheck {
  latestVersion: string;
  checkedAt: number;
}

function getCachePath(): string {
  return join(getDataDir(), "update-check.json");
}

function readCache(): CachedCheck | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(data: CachedCheck): void {
  try {
    writeFileSync(getCachePath(), JSON.stringify(data));
  } catch {}
}

function compareVersions(current: string, latest: string): number {
  const a = current.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return -1;
    if ((a[i] ?? 0) > (b[i] ?? 0)) return 1;
  }
  return 0;
}

export async function checkForUpdate(
  currentVersion: string,
  silent: boolean = false
): Promise<void> {
  const cache = readCache();
  const now = Date.now();

  // Cache hit — skip network, only notify if not silent
  if (cache && now - cache.checkedAt < CHECK_INTERVAL) {
    if (!silent && compareVersions(currentVersion, cache.latestVersion) < 0) {
      printUpdateNotice(currentVersion, cache.latestVersion);
    }
    return;
  }

  // Cache miss — fetch in background, don't block
  try {
    const res = await fetch("https://registry.npmjs.org/shellwise/latest", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version: string };
    writeCache({ latestVersion: data.version, checkedAt: now });

    if (!silent && compareVersions(currentVersion, data.version) < 0) {
      printUpdateNotice(currentVersion, data.version);
    }
  } catch {}
}

export function getUpdateNotice(currentVersion: string): string | null {
  const cache = readCache();
  if (!cache) return null;
  if (compareVersions(currentVersion, cache.latestVersion) < 0) {
    return `Update available: ${currentVersion} → ${cache.latestVersion}. Run: brew upgrade shellwise | bun install -g shellwise@latest | npm install -g shellwise@latest`;
  }
  return null;
}

function printUpdateNotice(current: string, latest: string): void {
  console.log(
    `\n${color.yellow}Update available: ${current} → ${latest}${color.reset}` +
      `\n${color.dim}Run: brew upgrade shellwise | bun install -g shellwise@latest | npm install -g shellwise@latest${color.reset}`
  );
}
