/**
 * The suggest path is asynchronous: the widget writes the request and returns,
 * and `zle -F` delivers the answer later. Outside a real line editor there is
 * no ZLE to run that handler, so these tests cover the two halves separately —
 * what goes out on the socket, and how a reply is turned into the two arrays.
 * The round trip as a whole is covered in zsh-async-suggest.test.ts, under tmux.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { hasZsh, runZshProbe } from "./zsh-harness";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Subprocess } from "bun";

const zsh = hasZsh();
let daemonProc: Subprocess | null = null;

afterEach(() => {
  daemonProc?.kill();
  daemonProc = null;
});

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

describe.skipIf(!zsh)("what __sw_suggest sends", () => {
  test("asks for tagged lines and returns without waiting", () => {
    const daemon = startFakeDaemon("history\tgit status\n\n");
    const out = runZshProbe(
      `
      BUFFER="git st"
      __sw_suggest
      print "orig:$__sw_original"
      print "queued:$__sw_squeue[1]"
      print "returned"
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );

    expect(out.stderr).toBe("");
    expect(daemon.requests()).toEqual(["SUGGEST\tgit st\t5\tv2"]);
    expect(out.stdout).toContain("orig:git st");
    // The line it asked about is remembered, so a late reply can be matched.
    expect(out.stdout).toContain("queued:git st");
    expect(out.stdout).toContain("returned");
  });

  test("a buffer shorter than two characters never hits the daemon", () => {
    const daemon = startFakeDaemon("history\tgit status\n\n");
    runZshProbe(`BUFFER="g"; __sw_suggest`, { SHELLWISE_SOCKET: daemon.socket });
    expect(daemon.requests()).toEqual([]);
  });

  test("a pasted wall of text never hits the daemon", () => {
    const daemon = startFakeDaemon("history\tgit status\n\n");
    runZshProbe(`BUFFER="${"x".repeat(250)}"; __sw_suggest`, {
      SHELLWISE_SOCKET: daemon.socket,
    });
    expect(daemon.requests()).toEqual([]);
  });
});

describe.skipIf(!zsh)("__sw_parse_reply", () => {
  test("splits a v2 reply into commands and their sources", () => {
    const out = runZshProbe(`
      __sw_parse_reply $'history\\tgit status\\ncommon\\tgit stash\\n'
      print "n:\${#__sw_suggestions}"
      print "c1:$__sw_suggestions[1] s1:$__sw_sources[1]"
      print "c2:$__sw_suggestions[2] s2:$__sw_sources[2]"
    `);
    expect(out.stdout).toContain("n:2");
    expect(out.stdout).toContain("c1:git status s1:history");
    expect(out.stdout).toContain("c2:git stash s2:common");
  });

  test("a daemon that predates v2 still fills the list, just without tags", () => {
    const out = runZshProbe(`
      __sw_parse_reply $'git status\\ngit stash\\n'
      print "n:\${#__sw_suggestions}"
      print "c1:$__sw_suggestions[1]"
      print "s1:[$__sw_sources[1]]"
    `);
    expect(out.stdout).toContain("n:2");
    expect(out.stdout).toContain("c1:git status");
    expect(out.stdout).toContain("s1:[]");
  });

  test("a command containing a tab survives the split intact", () => {
    const out = runZshProbe(`
      __sw_parse_reply $'history\\techo a\\tb\\n'
      print "s1:$__sw_sources[1]"
      print "c1:[$__sw_suggestions[1]]"
    `);
    expect(out.stdout).toContain("s1:history");
    expect(out.stdout).toContain("c1:[echo a\tb]");
  });
});
