import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Spawns a real daemon, so everything it touches lives in a private temp dir:
// its own socket, pid file and history DB. Never the developer's real ones.
let dir = "";
let env: Record<string, string>;

function sw(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, "src/index.ts", ...args], { env, cwd: process.cwd() });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sw-"));
  env = {
    ...(process.env as Record<string, string>),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    SHELLWISE_SOCKET: join(dir, "t.sock"),
  };
});

afterAll(() => {
  // Runs even when an assertion failed, so a daemon can never leak.
  try {
    sw("daemon", "stop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("daemon lifecycle", () => {
  test("start, status from another process, add, suggest, stop", () => {
    const start = sw("daemon", "start");
    expect(start.code).toBe(0);
    expect(start.out).toContain("Daemon started");

    expect(sw("daemon", "status").out).toContain("Daemon running");

    expect(sw("add", "--command", "echo lifecycle-test", "--exit-code", "0").code).toBe(0);
    expect(sw("suggest", "--query", "echo life").out).toContain("echo lifecycle-test");

    expect(sw("daemon", "stop").out).toContain("Daemon stopped");
    expect(sw("daemon", "status").out).toContain("Daemon not running");
  });
});
