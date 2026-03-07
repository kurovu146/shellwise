import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

const home = homedir();

export function getDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const dir = xdg ? join(xdg, "shellwise") : join(home, ".local", "share", "shellwise");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = xdg ? join(xdg, "shellwise") : join(home, ".config", "shellwise");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getDbPath(): string {
  return join(getDataDir(), "history.db");
}

export function getLogPath(): string {
  return join(getDataDir(), "debug.log");
}
