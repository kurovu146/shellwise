/**
 * Suggestions have to survive a slow link.
 *
 * `__sw_query` waited 200 ms for a reply — fine for a local socket that answers
 * in 1–3 ms, hopeless for `sw ssh`, where every keystroke crosses the network
 * twice. Measured against a real host: 246 ms round trip. Every keystroke timed
 * out, the shell treated it as a dead connection and reconnected, and typing
 * crawled.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateZshScript } from "../../src/cli/init";
import { hasZsh, runZshProbe } from "./zsh-harness";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Subprocess } from "bun";

const zsh = hasZsh();
let daemonProc: Subprocess | null = null;

afterEach(() => {
  daemonProc?.kill();
  daemonProc = null;
});

/** A daemon that answers `delayMs` later, the way a forwarded socket does. */
function startSlowDaemon(reply: string, delayMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-slow-"));
  const socket = join(dir, "d.sock");

  daemonProc = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fake-daemon.ts"),
    socket,
    join(dir, "req.log"),
    Buffer.from(reply).toString("base64"),
    String(delayMs),
  ]);

  const deadline = Date.now() + 5000;
  while (!existsSync(socket) && Date.now() < deadline) Bun.sleepSync(10);
  if (!existsSync(socket)) throw new Error("fake daemon never came up");
  return socket;
}

describe("read timeout", () => {
  test("the remote script waits long enough for a round trip", () => {
    const remote = generateZshScript("shellwise", { remote: true });
    const local = generateZshScript("shellwise", { remote: false });

    const remoteTimeout = Number(remote.match(/read -r -t ([\d.]+)/)?.[1]);
    const localTimeout = Number(local.match(/read -r -t ([\d.]+)/)?.[1]);

    // A 250 ms round trip is ordinary for a VPS a continent away.
    expect(remoteTimeout).toBeGreaterThan(0.5);
    expect(localTimeout).toBeLessThanOrEqual(0.5);
  });
});

describe.skipIf(!zsh)("a slow daemon", () => {
  test("does not hold up the widget that asked", () => {
    // Never answers. Sending is synchronous, waiting is not — so the widget
    // has to come back immediately either way.
    const socket = startSlowDaemon("history\tgit status\n\n", 60_000);
    const started = Date.now();
    const out = runZshProbe(`BUFFER="git st"; __sw_suggest; print "done"`, {
      SHELLWISE_SOCKET: socket,
    });
    const elapsed = Date.now() - started;

    expect(out.stdout).toContain("done");
    // Shell startup dominates; the point is that no round trip is waited on.
    expect(elapsed).toBeLessThan(3000);
  });
});
