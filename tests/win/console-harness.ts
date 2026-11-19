// Windows end-to-end harness: run a program in its own hidden console, drive
// it with tests/win/console-driver.ts, and clean up after it.
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Screen, Step } from "./console-driver";

export type { KeyName, Screen, Step } from "./console-driver";

const DRIVER = join(import.meta.dir, "console-driver.ts");

/** Quote one argument for a Windows command line (CommandLineToArgvW rules). */
function quoteArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Start `file args...` in a new, hidden console window and return its pid.
 * `env` is layered over the current environment and inherited by the child.
 */
export function startHiddenConsole(file: string, args: string[], env: Record<string, string>): number {
  const argList = args.length > 0 ? ` -ArgumentList ${psQuote(args.map(quoteArg).join(" "))}` : "";
  const command = `(Start-Process -FilePath ${psQuote(file)}${argList} -WindowStyle Hidden -PassThru).Id`;
  const p = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", command], {
    env: { ...process.env, ...env },
  });
  const pid = Number.parseInt(p.stdout.toString().trim(), 10);
  if (p.exitCode !== 0 || !Number.isInteger(pid)) {
    throw new Error(`Start-Process failed (exit ${p.exitCode}): ${p.stderr.toString()}`);
  }
  return pid;
}

/** Run `steps` against the console of `pid`; returns the captured screens. */
export function drive(pid: number, steps: Step[]): Screen[] {
  const dir = mkdtempSync(join(tmpdir(), "sw-drive-"));
  try {
    const stepsFile = join(dir, "steps.json");
    writeFileSync(stepsFile, JSON.stringify(steps));
    const p = Bun.spawnSync([process.execPath, DRIVER, String(pid), stepsFile], { timeout: 60_000 });
    if (p.exitCode !== 0) {
      throw new Error(`console driver failed (exit ${p.exitCode}):\n${p.stderr.toString()}`);
    }
    return JSON.parse(p.stdout.toString()) as Screen[];
  } finally {
    removeDir(dir);
  }
}

/** Kill `pid` and every process it started. Never throws. */
export function killTree(pid: number): void {
  Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` has exited; false if it is still running after `timeoutMs`. */
export function waitForExit(pid: number, timeoutMs = 5000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    Bun.sleepSync(50);
  }
  return true;
}

/**
 * Remove a temp dir. Right after a kill Windows can still hold files open
 * (EBUSY), and Bun ignores rmSync's maxRetries there, so retry by hand and
 * give up quietly: a leftover temp dir must not fail a test.
 */
export function removeDir(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(100);
    }
  }
}
