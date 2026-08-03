import { generateZshScript } from "../../src/cli/init";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function hasZsh(): boolean {
  return Bun.spawnSync(["which", "zsh"]).exitCode === 0;
}

/**
 * Source the generated integration in a bare `zsh -f` and run `body` against it.
 *
 * Remote mode on purpose: that branch never shells out to the binary, so a test
 * can never accidentally start a real daemon. `zle`/`bindkey` are stubbed
 * because ZLE is not loaded outside an interactive line editor — the functions
 * under test only write plain variables, so they run fine without it.
 */
export function runZshProbe(
  body: string,
  env: Record<string, string> = {}
): { stdout: string; stderr: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), "sw-zsh-"));
  const script = join(dir, "sw.zsh");
  const probe = join(dir, "probe.zsh");

  writeFileSync(script, generateZshScript("shellwise", { remote: true }));
  writeFileSync(probe, `zle() { : }\nbindkey() { : }\nsource ${script}\n${body}\n`);

  const p = Bun.spawnSync(["zsh", "-f", probe], { env: { ...process.env, ...env } });
  return {
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
    exitCode: p.exitCode,
  };
}
