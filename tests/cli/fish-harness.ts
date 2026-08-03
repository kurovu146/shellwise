import { generateFishScript } from "../../src/cli/init/fish";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function hasFish(): boolean {
  return Bun.spawnSync(["which", "fish"]).exitCode === 0;
}

/** set_color prints escapes even when stdout is not a tty, so tests strip them. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\(B/g, "")
    .replace(/\x0f/g, "");
}

/**
 * Source the generated fish integration in a clean fish and run `body`.
 *
 * `--no-config` keeps the user's own config out of the picture. Sourcing is
 * non-interactive, so the script's `status is-interactive` guard means no
 * daemon is started and no key is rebound — only the functions get defined.
 */
export function runFishProbe(
  body: string,
  env: Record<string, string> = {}
): { stdout: string; stderr: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), "sw-fish-"));
  const script = join(dir, "sw.fish");
  const probe = join(dir, "probe.fish");

  writeFileSync(script, generateFishScript("shellwise"));
  writeFileSync(probe, `source ${script}\n${body}\n`);

  const p = Bun.spawnSync(["fish", "--no-config", probe], {
    env: { ...process.env, ...env },
  });
  return {
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
    exitCode: p.exitCode,
  };
}
