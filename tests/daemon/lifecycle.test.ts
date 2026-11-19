import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { connect, createServer } from "net";

// Spawns real daemons, so everything they touch lives in a private temp dir:
// own socket, pid file and history DB. Never the developer's real ones.
// SHELLWISE_DAEMON_SOCKET is our internal override; SHELLWISE_SOCKET belongs to
// the shell integrations and is deliberately not used here.
const ENTRY = resolve(import.meta.dir, "../../src/index.ts");
const REPO = resolve(import.meta.dir, "../..");
let dir = "";

function envFor(name: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    SHELLWISE_DAEMON_SOCKET: join(dir, `${name}.sock`),
  };
}

// Async so this process's event loop keeps serving the in-process fake daemons
// below; the timeout makes a hung child fail the test instead of the CI job.
async function sw(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn([process.execPath, ENTRY, ...args], {
    env,
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

function rawRequest(socketPath: string, message: string): Promise<string> {
  return new Promise((resolveReq, reject) => {
    const s = connect(socketPath);
    let data = "";
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error("no reply from daemon socket"));
    }, 3000);
    s.on("connect", () => s.write(message));
    s.on("data", (c) => {
      data += c.toString();
      if (data.includes("\n\n")) {
        clearTimeout(timer);
        s.destroy();
        resolveReq(data);
      }
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sw-"));
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (isAlive(pid) && Date.now() < end) await Bun.sleep(50);
  return !isAlive(pid);
}

afterAll(async () => {
  // Do not trust the CLI under test to clean up: kill any daemon whose pid
  // file is left in our temp dir (never our own pid, which the stale-pid
  // tests write on purpose), wait for it to release its files, then remove
  // the directory. Cleanup itself must never throw.
  try {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".pid"))) {
      const pid = parseInt(readFileSync(join(dir, f), "utf-8"));
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid);
        } catch {}
        await waitGone(pid);
      }
    }
  } catch {}
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
});

describe("daemon lifecycle", () => {
  test("start, status from another process, add, suggest, stop", async () => {
    const env = envFor("t");
    const sock = env.SHELLWISE_DAEMON_SOCKET;

    const start = await sw(env, "daemon", "start");
    expect(start.code).toBe(0);
    expect(start.out).toContain("Daemon started");

    expect((await sw(env, "daemon", "status")).out).toContain("Daemon running");

    // The CLI falls back to the DB when no daemon answers, so also talk to the
    // socket directly: only a live daemon can satisfy these.
    expect(await rawRequest(sock, "PING\n")).toContain("PONG");

    expect((await sw(env, "add", "--command", "echo lifecycle-test", "--exit-code", "0")).code).toBe(0);
    expect((await sw(env, "suggest", "--query", "echo life")).out).toContain("echo lifecycle-test");
    expect(await rawRequest(sock, "SUGGEST\techo life\t5\tv2\n")).toContain("history\techo lifecycle-test");

    expect((await sw(env, "daemon", "stop")).out).toContain("Daemon stopped");
    expect((await sw(env, "daemon", "status")).out).toContain("Daemon not running");
  });
});

describe("stale pid file", () => {
  test("a live pid that is not a daemon counts as not running, and start replaces it", async () => {
    const env = envFor("stale");
    const pidFile = join(dir, "stale.pid");
    // This test process is alive but is not a daemon, and nothing listens.
    writeFileSync(pidFile, String(process.pid));

    const status = await sw(env, "daemon", "status");
    expect(status.out).toContain("Daemon not running");
    expect(existsSync(pidFile)).toBe(false);

    writeFileSync(pidFile, String(process.pid));
    const start = await sw(env, "daemon", "start");
    expect(start.code).toBe(0);
    expect(start.out).toContain("Daemon started");
    expect(readFileSync(pidFile, "utf-8").trim()).not.toBe(String(process.pid));

    expect((await sw(env, "daemon", "stop")).out).toContain("Daemon stopped");
  });
});

describe("daemon stop failure", () => {
  test("reports an error and exits 1 when the daemon acknowledges STOP but stays alive", async () => {
    const env = envFor("stuck");
    const sock = env.SHELLWISE_DAEMON_SOCKET;
    const pidFile = join(dir, "stuck.pid");
    // Fake daemon: answers PING and STOP but never exits. Its pid is ours.
    const fake = createServer((c) => {
      c.on("data", (d) => c.write(d.toString().startsWith("STOP") ? "BYE\n\n" : "PONG\n\n"));
    });
    await new Promise<void>((r) => fake.listen(sock, r));
    writeFileSync(pidFile, String(process.pid));
    try {
      const stop = await sw(env, "daemon", "stop");
      expect(stop.code).toBe(1);
      expect(stop.err).toContain("Failed to stop daemon");
      expect(stop.out).not.toContain("Daemon stopped");
    } finally {
      fake.close();
      rmSync(pidFile, { force: true });
    }
  }, 15000); // the CLI waits ~3s for the daemon to exit before giving up
});

describe("live but silent daemon", () => {
  test("a listener that accepts but never replies is alive: nothing is deleted", async () => {
    const env = envFor("silent");
    const sock = env.SHELLWISE_DAEMON_SOCKET;
    const pidFile = join(dir, "silent.pid");
    const conns: import("net").Socket[] = [];
    const busy = createServer((c) => {
      conns.push(c); // accept, never reply: a daemon blocked on the DB lock
    });
    await new Promise<void>((r) => busy.listen(sock, r));
    writeFileSync(pidFile, String(process.pid));
    try {
      const status = await sw(env, "daemon", "status");
      expect(status.out).toContain("Daemon running");
      expect(existsSync(pidFile)).toBe(true);
      expect(existsSync(sock)).toBe(true);

      const start = await sw(env, "daemon", "start");
      expect(start.out).toContain("Daemon already running");
      expect(existsSync(pidFile)).toBe(true);
      expect(existsSync(sock)).toBe(true);
    } finally {
      conns.forEach((c) => c.destroy());
      busy.close();
      rmSync(pidFile, { force: true });
    }
  }, 15000);
});

describe("endpoint ownership on exit", () => {
  test("a daemon that lost its pid file does not delete the successor's", async () => {
    const env = envFor("owner");
    const sock = env.SHELLWISE_DAEMON_SOCKET;
    const pidFile = join(dir, "owner.pid");

    expect((await sw(env, "daemon", "start")).out).toContain("Daemon started");
    const realPid = parseInt(readFileSync(pidFile, "utf-8"));
    // Hand the pid file to a "successor" (this process), then stop the daemon.
    writeFileSync(pidFile, String(process.pid));
    expect(await rawRequest(sock, "STOP\n")).toContain("BYE");
    expect(await waitGone(realPid)).toBe(true);

    expect(readFileSync(pidFile, "utf-8").trim()).toBe(String(process.pid));
    rmSync(pidFile, { force: true });
  }, 15000);
});
