import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, rmdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { connect, createServer } from "net";
import { Database } from "bun:sqlite";
import { probeDaemon } from "../../src/daemon/client";
import { parseTestDelay } from "../../src/daemon/server";
import { daemonPids as findDaemonPids, runsDaemon } from "./daemon-processes";

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

/**
 * A pid file left behind: written an hour ago. A fresh one whose pid is alive
 * is a daemon still starting, and is waited for (START_GRACE_MS).
 */
function writeLeftoverPidFile(path: string, pid: number): void {
  writeFileSync(path, String(pid));
  const anHourAgo = new Date(Date.now() - 3600_000);
  utimesSync(path, anHourAgo, anHourAgo);
}

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

async function killDaemon(pid: number): Promise<void> {
  if (!pid || pid === process.pid) return;
  try {
    process.kill(pid);
  } catch {}
  await waitGone(pid);
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
  // Bun ignores rmSync's maxRetries on Windows and a killed daemon releases
  // history.db a moment late, so retry explicitly and swallow the last failure.
  const end = Date.now() + 3000;
  while (existsSync(dir) && Date.now() < end) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      await Bun.sleep(100);
    }
  }
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

// Windows only: there a process's working directory cannot be renamed or
// removed (EBUSY), so a daemon that kept its starter's folder pinned it.
describe.skipIf(process.platform !== "win32")("daemon working directory", () => {
  test("the folder the daemon was started from can be renamed and removed while it runs", async () => {
    const env = envFor("cwd");
    const start = join(dir, "start-folder");
    mkdirSync(start);
    const p = Bun.spawn([process.execPath, ENTRY, "daemon", "start"], { env, cwd: start, stdout: "pipe", timeout: 20000 });
    expect(await new Response(p.stdout).text()).toContain("Daemon started");
    try {
      expect((await sw(env, "daemon", "status")).out).toContain("Daemon running");
      const moved = join(dir, "start-folder-moved");
      renameSync(start, moved);
      rmdirSync(moved);
      expect(existsSync(moved)).toBe(false);
    } finally {
      await sw(env, "daemon", "stop");
    }
  });
});

describe("relative data dir", () => {
  test("a relative XDG_DATA_HOME gives the daemon the same DB the CLI uses", async () => {
    const cwd = join(dir, "rel-cwd");
    mkdirSync(cwd);
    const env = { ...envFor("rel"), XDG_DATA_HOME: "rel-data", XDG_CONFIG_HOME: "rel-config" };
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, ENTRY, ...args], { env, cwd, stdout: "pipe", stderr: "pipe", timeout: 20000 });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return out;
    };
    try {
      expect(await run("daemon", "start")).toContain("Daemon started");
      await run("add", "--command", "echo relative-dir", "--exit-code", "0");
      expect(await run("suggest", "--query", "echo relative")).toContain("echo relative-dir");
    } finally {
      await run("daemon", "stop");
    }
    // The daemon runs in the data dir: had it resolved "rel-data" again from
    // there, a second DB would sit at rel-data/shellwise/rel-data/shellwise.
    const dbs = (readdirSync(cwd, { recursive: true }) as string[]).filter((f) => f.endsWith("history.db"));
    expect(dbs).toEqual([join("rel-data", "shellwise", "history.db")]);
    const db = new Database(join(cwd, "rel-data", "shellwise", "history.db"), { readonly: true });
    try {
      expect(db.query("SELECT command FROM commands").all()).toEqual([{ command: "echo relative-dir" }]);
    } finally {
      db.close();
    }
  }, 30_000);
});

// The daemon outlives `daemon start`: it must not keep the starter's output
// pipe, or a caller reading that output to EOF waits until the daemon stops.
describe("daemon start and the caller's output pipe", () => {
  /** stdout+stderr of `p` read to EOF, or null if EOF did not come within 10s. */
  async function readToEof(p: { stdout: ReadableStream; stderr: ReadableStream }) {
    const both = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return Promise.race([both, Bun.sleep(10_000).then(() => null)]);
  }

  test("a piped caller gets EOF when `daemon start` exits, and the daemon keeps running", async () => {
    const env = envFor("pipe");
    try {
      const p = Bun.spawn([process.execPath, ENTRY, "daemon", "start"], { env, stdout: "pipe", stderr: "pipe" });
      const out = await readToEof(p);
      expect(out).not.toBeNull();
      expect(out![0]).toContain("Daemon started");
      expect((await sw(env, "daemon", "status")).out).toContain("Daemon running");
    } finally {
      await sw(env, "daemon", "stop");
    }
  }, 20_000);

  // Started through cmd.exe with its own output redirected, `daemon start`
  // holds the caller's pipe as a plain inherited handle, not as stdout: the
  // way PowerShell's background spawns hand it down.
  test.skipIf(process.platform !== "win32")(
    "the same through cmd.exe, where the pipe reaches `daemon start` as a plain inherited handle",
    async () => {
      const env = envFor("cmdpipe");
      try {
        const line = `""${process.execPath}" "${ENTRY}" daemon start >NUL 2>NUL"`;
        const p = Bun.spawn(["cmd.exe", "/d", "/s", "/c", line], { env, stdout: "pipe", stderr: "pipe", windowsVerbatimArguments: true });
        expect(await readToEof(p)).not.toBeNull();
        expect((await sw(env, "daemon", "status")).out).toContain("Daemon running");
      } finally {
        await sw(env, "daemon", "stop");
      }
    },
    20_000
  );
});

describe("stale pid file", () => {
  test("a live pid that is not a daemon counts as not running, and start replaces it", async () => {
    const env = envFor("stale");
    const pidFile = join(dir, "stale.pid");
    // This test process is alive but is not a daemon, and nothing listens.
    writeLeftoverPidFile(pidFile, process.pid);

    const status = await sw(env, "daemon", "status");
    expect(status.out).toContain("Daemon not running");
    expect(existsSync(pidFile)).toBe(false);

    writeLeftoverPidFile(pidFile, process.pid);
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
  test("a daemon that lost its pid file leaves the successor's socket and pid file alone", async () => {
    const env = envFor("owner");
    const sock = env.SHELLWISE_DAEMON_SOCKET;
    const pidFile = join(dir, "owner.pid");
    let pid1 = 0;
    let pid2 = 0;
    let held: import("net").Socket | undefined;
    try {
      expect((await sw(env, "daemon", "start")).out).toContain("Daemon started");
      pid1 = parseInt(readFileSync(pidFile, "utf-8"));
      // Keep a connection to D1 open: once D2 takes over the path, this is the
      // only way left to reach D1.
      held = connect(sock);
      await new Promise<void>((r, rej) => {
        held!.once("connect", () => r());
        held!.once("error", rej);
      });
      // D1 loses ownership (pid file gone); a second start brings up D2 on the same path.
      rmSync(pidFile);
      expect((await sw(env, "daemon", "start")).out).toContain("Daemon started");
      pid2 = parseInt(readFileSync(pidFile, "utf-8"));
      expect(pid2).not.toBe(pid1);

      // D1 now exits through its stop path, as the idle timer would make it.
      held.write("STOP\n");
      expect(await waitGone(pid1)).toBe(true);

      // D2's endpoint must be intact: pid file, socket file (Windows deletes it
      // when a listener is stopped) and a live answer.
      expect(parseInt(readFileSync(pidFile, "utf-8"))).toBe(pid2);
      expect(existsSync(sock)).toBe(true);
      expect(await rawRequest(sock, "PING\n")).toContain("PONG");
      expect((await sw(env, "daemon", "status")).out).toContain("Daemon running");
    } finally {
      held?.destroy();
      await killDaemon(pid1);
      await killDaemon(pid2);
    }
  }, 20000);
});

/** Pids of every `daemon _run` of this checkout's entry point. */
const daemonPids = () => findDaemonPids(basename(process.execPath), ENTRY);

describe("finding daemon processes", () => {
  test("a quoted program path with a space still matches", () => {
    const program = process.platform === "win32" ? "C:\\work\\sp ace\\src\\index.ts" : "/work/sp ace/src/index.ts";
    expect(runsDaemon(`bun.exe "${program}" daemon _run`, program)).toBe(true);
    expect(runsDaemon(`bun ${program} daemon _run`, program)).toBe(true);
    expect(runsDaemon(`bun "${program}" daemon start`, program)).toBe(false);
    expect(runsDaemon(`bun "${program.replace("sp ace", "other")}" daemon _run`, program)).toBe(false);
  });
});

describe("concurrent starts", () => {
  test("six `daemon start` at once leave exactly one daemon, round after round", async () => {
    // Daemons of this entry that exist already (a developer's own) are not ours.
    const foreign = new Set(daemonPids());
    const ours = () => daemonPids().filter((p) => !foreign.has(p));
    for (let round = 0; round < 10; round++) {
      const env = envFor(`race${round}`);
      const pidFile = join(dir, `race${round}.pid`);
      try {
        const starts = Array.from({ length: 6 }, () =>
          Bun.spawn([process.execPath, ENTRY, "daemon", "start"], { env, cwd: REPO, stdout: "pipe", stderr: "pipe", timeout: 20000 })
        );
        const results = await Promise.all(
          starts.map(async (p) => {
            const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
            return { code, out: out.trim(), err: err.trim() };
          })
        );
        // Each start succeeds: it started the daemon, or found the winner's.
        for (const r of results) {
          expect(r).toMatchObject({ code: 0, err: "" });
          expect(r.out).toMatch(/^Daemon (started \(pid: \d+\)|already running\.)$/);
        }
        // The starts that lost exit once the winner answers: allow them a moment.
        const deadline = Date.now() + 5000;
        while (ours().length > 1 && Date.now() < deadline) await Bun.sleep(200);
        const alive = ours();
        expect({ round, alive }).toEqual({ round, alive: [parseInt(readFileSync(pidFile, "utf-8"))] });
        expect(await rawRequest(env.SHELLWISE_DAEMON_SOCKET, "PING\n")).toContain("PONG");

        expect((await sw(env, "daemon", "stop")).out).toContain("Daemon stopped");
        expect(await waitGone(alive[0])).toBe(true);
        expect(ours()).toEqual([]);
      } finally {
        // Never leave a daemon of a failed round running.
        for (const pid of ours()) await killDaemon(pid);
      }
    }
  }, 240_000);
});

describe("a daemon still starting", () => {
  test("a fresh pid file of a live pid that never answers is waited for, then taken over", async () => {
    const env = envFor("young");
    const pidFile = join(dir, "young.pid");
    // Fresh, alive, nothing listening: a daemon between taking its pid file
    // and binding the socket looks the same, for at most the grace.
    writeFileSync(pidFile, String(process.pid));
    let pid = 0;
    try {
      const t0 = Date.now();
      const start = await sw(env, "daemon", "start");
      expect(start.code).toBe(0);
      expect(start.out).toContain("Daemon started");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2500);
      pid = parseInt(readFileSync(pidFile, "utf-8"));
      expect(pid).not.toBe(process.pid);
      expect(await rawRequest(env.SHELLWISE_DAEMON_SOCKET, "PING\n")).toContain("PONG");
    } finally {
      await killDaemon(pid);
    }
  }, 20000);

  test("a pid file dated in the future is waited for at most the grace, by this process's clock", async () => {
    // A clock set back since the file was written (time sync, dual boot, a
    // restored backup): by its mtime, the file would look young for an hour.
    const env = envFor("future");
    const pidFile = join(dir, "future.pid");
    const writeFuturePidFile = () => {
      writeFileSync(pidFile, String(process.pid));
      const inAnHour = new Date(Date.now() + 3600_000);
      utimesSync(pidFile, inAnHour, inAnHour);
    };
    let pid = 0;
    try {
      writeFuturePidFile();
      let t0 = Date.now();
      const status = await sw(env, "daemon", "status");
      expect({ code: status.code, out: status.out.trim(), ms: Date.now() - t0 < 8000 }).toEqual({
        code: 0,
        out: "Daemon not running.",
        ms: true,
      });

      writeFuturePidFile();
      t0 = Date.now();
      const start = await sw(env, "daemon", "start");
      expect({ code: start.code, started: start.out.includes("Daemon started"), ms: Date.now() - t0 < 10000 }).toEqual({
        code: 0,
        started: true,
        ms: true,
      });
      pid = parseInt(readFileSync(pidFile, "utf-8"));
      expect(pid).not.toBe(process.pid);
      expect(await rawRequest(env.SHELLWISE_DAEMON_SOCKET, "PING\n")).toContain("PONG");
    } finally {
      await killDaemon(pid);
    }
  }, 45_000);
});

describe("test-only start delays", () => {
  test("only a positive number is a delay, and at most a minute", () => {
    for (const raw of [undefined, "", "abc", "NaN", "0", "-5", "Infinity", "-Infinity"]) expect(parseTestDelay(raw)).toBe(0);
    expect(parseTestDelay("3500")).toBe(3500);
    expect(parseTestDelay("1e12")).toBe(60_000);
    expect(parseTestDelay("2147483648")).toBe(60_000);
  });
});

// A daemon that takes longer than the grace between its pid file and its bind
// is judged stale and taken over by a later start. Test-only delays make a
// start slow: BIND before its ownership check, UNLINK between that check and
// the socket path (where only the check after the bind sees a take-over).
describe("a daemon slower than the grace", () => {
  type Delays = { bind?: number; unlink?: number };

  async function slowStarts(name: string, slow: Delays[], late: Delays | null) {
    const env = envFor(`slow-${name}`);
    const pidFile = join(dir, `slow-${name}.pid`);
    const foreign = new Set(daemonPids());
    const ours = () => daemonPids().filter((p) => !foreign.has(p));
    const run = (d: Delays) =>
      Bun.spawn([process.execPath, ENTRY, "daemon", "_run"], {
        env: {
          ...env,
          SHELLWISE_TEST_BIND_DELAY_MS: String(d.bind ?? 0),
          SHELLWISE_TEST_UNLINK_DELAY_MS: String(d.unlink ?? 0),
        },
        cwd: dir,
        stdio: ["ignore", "ignore", "ignore"],
      });
    const holder = () => {
      const content = existsSync(pidFile) ? readFileSync(pidFile, "utf-8").trim() : "";
      return content ? parseInt(content) : null;
    };
    try {
      const started = slow.map(run);
      const deadline = Date.now() + 5000;
      while (holder() === null && Date.now() < deadline) await Bun.sleep(20);
      // Started together, any of them may have taken it.
      const firstHolder = holder();
      expect(started.map((p) => p.pid)).toContain(firstHolder);
      // This one, and the others started with the first, wait out the grace
      // (3 s after the pid file) and take it over.
      const lateStart = late ? run(late) : null;
      // Settled: one daemon of ours left and answering, or the time is up.
      let answer = "";
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        answer = await rawRequest(env.SHELLWISE_DAEMON_SOCKET, "PING\n").catch(() => "");
        if (answer && ours().length === 1) break;
        await Bun.sleep(200);
      }
      return { started, firstHolder, lateStart, result: { answer, alive: ours(), pidFile: holder() } };
    } finally {
      for (const pid of ours()) await killDaemon(pid);
    }
  }

  test("woken after the later start has bound: it leaves without touching the socket", async () => {
    // Checks the pid file at 5 s; the later start took it at 3 s and bound.
    const { lateStart, result } = await slowStarts("pre", [{ bind: 5000 }], {});
    expect(result).toEqual({ answer: "PONG\n\n", alive: [lateStart!.pid], pidFile: lateStart!.pid });
  }, 40_000);

  test("taken over between its check and its bind: it binds, sees it, and leaves without stopping", async () => {
    // Passes its check at once, binds at 4.5 s; the later start takes the pid
    // file at 3 s and binds at 6 s, after removing the slow one's socket file.
    const { lateStart, result } = await slowStarts("post", [{ unlink: 4500 }], { unlink: 3000 });
    expect(result).toEqual({ answer: "PONG\n\n", alive: [lateStart!.pid], pidFile: lateStart!.pid });
  }, 40_000);

  test("three slow starts at once: one stays as the daemon, holding the pid file", async () => {
    // The two later ones both wait out the first; the one that loses the
    // race for the pid file then waits out the winner, which is slow too, and
    // removes its file: it must take the file itself, not leave none.
    const { started, firstHolder, result } = await slowStarts("three", [{ bind: 4000 }, { bind: 4000 }, { bind: 4000 }], null);
    expect(result.answer).toBe("PONG\n\n");
    expect(result.alive).toHaveLength(1);
    expect(started.map((p) => p.pid)).toContain(result.alive[0]);
    // The first holder is taken over at 3 s and leaves at its check.
    expect(result.alive[0]).not.toBe(firstHolder);
    expect(result.pidFile).toBe(result.alive[0]);
  }, 40_000);
});

describe("unreachable socket", () => {
  test("a live pid plus a leftover socket file nobody listens on is stale; start recovers", async () => {
    const env = envFor("dead");
    const sock = env.SHELLWISE_DAEMON_SOCKET;
    const pidFile = join(dir, "dead.pid");
    writeLeftoverPidFile(pidFile, process.pid);
    writeFileSync(sock, ""); // a file, not a listener: connect fails
    const saved = process.env.SHELLWISE_DAEMON_SOCKET;
    process.env.SHELLWISE_DAEMON_SOCKET = sock;
    let pid = 0;
    try {
      expect(await probeDaemon()).toBe("unreachable");
      const start = await sw(env, "daemon", "start");
      expect(start.code).toBe(0);
      expect(start.out).toContain("Daemon started");
      pid = parseInt(readFileSync(pidFile, "utf-8"));
      expect(pid).not.toBe(process.pid);
      expect(await rawRequest(sock, "PING\n")).toContain("PONG");
    } finally {
      if (saved === undefined) delete process.env.SHELLWISE_DAEMON_SOCKET;
      else process.env.SHELLWISE_DAEMON_SOCKET = saved;
      await killDaemon(pid);
    }
  }, 15000);
});
