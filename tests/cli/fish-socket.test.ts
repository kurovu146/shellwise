import { describe, test, expect, afterEach } from "bun:test";
import { hasFish, runFishProbe, stripAnsi } from "./fish-harness";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Subprocess } from "bun";

const fish = hasFish();
let daemonProc: Subprocess | null = null;

afterEach(() => {
  daemonProc?.kill();
  daemonProc = null;
});

/** Same stand-in daemon the zsh tests use; it must be its own process. */
function startFakeDaemon(reply: string): { socket: string; requests(): string[] } {
  const dir = mkdtempSync(join(tmpdir(), "sw-fsock-"));
  const socket = join(dir, "d.sock");
  const log = join(dir, "requests.log");

  daemonProc = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fake-daemon.ts"),
    socket,
    log,
    Buffer.from(reply).toString("base64"),
  ]);

  const deadline = Date.now() + 5000;
  while (!existsSync(socket) && Date.now() < deadline) Bun.sleepSync(10);
  if (!existsSync(socket)) throw new Error("fake daemon never came up");

  return {
    socket,
    requests: () =>
      existsSync(log)
        ? readFileSync(log, "utf-8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as string)
        : [],
  };
}

describe.skipIf(!fish)("__sw_suggest over the socket", () => {
  test("asks for tagged lines and splits them into two arrays", () => {
    const daemon = startFakeDaemon("history\tgit status\ncommon\tgit stash\n\n");
    const out = runFishProbe(
      `
      __sw_suggest "git st"
      echo "n:"(count $__sw_suggestions)
      echo "c1:$__sw_suggestions[1]"
      echo "s1:$__sw_sources[1]"
      echo "c2:$__sw_suggestions[2]"
      echo "s2:$__sw_sources[2]"
      echo "orig:$__sw_original"
      echo "sel:$__sw_selected"
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );
    expect(out.stderr).toBe("");
    expect(daemon.requests()).toEqual(["SUGGEST\tgit st\t5\tv2"]);
    expect(out.stdout).toContain("n:2");
    expect(out.stdout).toContain("c1:git status");
    expect(out.stdout).toContain("s1:history");
    expect(out.stdout).toContain("c2:git stash");
    expect(out.stdout).toContain("s2:common");
    expect(out.stdout).toContain("orig:git st");
    expect(out.stdout).toContain("sel:-1");
  });

  test("a daemon that predates v2 still fills the list, just without tags", () => {
    const daemon = startFakeDaemon("git status\ngit stash\n\n");
    const out = runFishProbe(
      `
      __sw_suggest "git st"
      echo "n:"(count $__sw_suggestions)
      echo "c1:$__sw_suggestions[1]"
      echo "s1:[$__sw_sources[1]]"
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );
    expect(out.stdout).toContain("n:2");
    expect(out.stdout).toContain("c1:git status");
    expect(out.stdout).toContain("s1:[]");
  });

  test("a buffer shorter than two characters never hits the daemon", () => {
    const daemon = startFakeDaemon("history\tgit status\n\n");
    const out = runFishProbe(
      `
      __sw_suggest "g"
      echo "n:"(count $__sw_suggestions)
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );
    expect(daemon.requests()).toEqual([]);
    expect(out.stdout).toContain("n:0");
  });

  test("a pasted wall of text never hits the daemon", () => {
    const daemon = startFakeDaemon("history\tgit status\n\n");
    const long = "x".repeat(250);
    const out = runFishProbe(
      `
      __sw_suggest "${long}"
      echo "n:"(count $__sw_suggestions)
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );
    expect(daemon.requests()).toEqual([]);
    expect(out.stdout).toContain("n:0");
  });

  test("with no transport available it stays silent instead of erroring", () => {
    const daemon = startFakeDaemon("history\tgit status\n\n");
    const out = runFishProbe(
      `
      set -g __sw_transport none
      __sw_suggest "git st"
      echo "n:"(count $__sw_suggestions)
      echo "done"
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );
    expect(out.stderr).toBe("");
    expect(out.stdout).toContain("n:0");
    expect(out.stdout).toContain("done");
  });

  test("the frame renders what the daemon sent", () => {
    const daemon = startFakeDaemon("history\tgit status\ncommon\tgit stash\n\n");
    const out = runFishProbe(
      `
      __sw_suggest "git st"
      __sw_box_lines 60
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );
    const clean = stripAnsi(out.stdout);
    expect(clean).toContain("git status");
    expect(clean).toContain("history │");
    expect(clean).toContain("common │");
  });
});
