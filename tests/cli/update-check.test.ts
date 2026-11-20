import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeDir } from "../win/console-harness";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

// The daily update check, run from a cached answer that says a newer version
// exists: no network involved.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sw-update-"));
  mkdirSync(join(dir, "data", "shellwise"), { recursive: true });
  writeFileSync(
    join(dir, "data", "shellwise", "update-check.json"),
    JSON.stringify({ latestVersion: "999.0.0", checkedAt: Date.now() })
  );
});
afterAll(() => removeDir(dir));

function version(optOut: string | undefined) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    SHELLWISE_DAEMON_SOCKET: join(dir, "d.sock"),
    SHELLWISE_NO_UPDATE_CHECK: optOut,
  };
  if (optOut === undefined) delete env.SHELLWISE_NO_UPDATE_CHECK;
  const p = Bun.spawnSync([process.execPath, ENTRY, "version"], { env });
  return { code: p.exitCode, out: p.stdout.toString() };
}

describe("update check", () => {
  test("SHELLWISE_NO_UPDATE_CHECK=1 turns it off: no notice", () => {
    const r = version("1");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Update available");
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("without it, a cached newer version still gives the notice", () => {
    const r = version(undefined);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Update available");
    expect(r.out).toContain("999.0.0");
  });

  test("the test run itself has it set, so every CLI a test starts inherits it", () => {
    expect(process.env.SHELLWISE_NO_UPDATE_CHECK).toBe("1");
  });
});
