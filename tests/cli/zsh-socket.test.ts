/**
 * End-to-end over a real socket: the generated zsh integration talks to a
 * stand-in daemon, so the v2 handshake and the tab-splitting are exercised for
 * real rather than assumed. Remote mode reads its socket path from
 * SHELLWISE_SOCKET, which is what lets this run without touching the user's own
 * daemon.
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

interface FakeDaemon {
  socket: string;
  /** Every request line the daemon received, tabs intact. */
  requests(): string[];
}

function startFakeDaemon(reply: string): FakeDaemon {
  const dir = mkdtempSync(join(tmpdir(), "sw-sock-"));
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

describe.skipIf(!zsh)("__sw_suggest over the socket", () => {
  test("asks the daemon for tagged lines and splits them into two arrays", () => {
    const daemon = startFakeDaemon("history\tgit status\ncommon\tgit stash\n\n");

    const out = runZshProbe(
      `
      BUFFER="git st"
      COLUMNS=60
      __sw_suggest
      print -r -- "n:\${#__sw_suggestions}"
      print -r -- "c1:\${__sw_suggestions[1]}"
      print -r -- "s1:\${__sw_sources[1]}"
      print -r -- "c2:\${__sw_suggestions[2]}"
      print -r -- "s2:\${__sw_sources[2]}"
      print -r -- "orig:\$__sw_original"
      print -r -- "$POSTDISPLAY"
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
    expect(out.stdout).toContain("history │");
    expect(out.stdout).toContain("common │");
  });

  test("a daemon that predates v2 still fills the list, just without tags", () => {
    const daemon = startFakeDaemon("git status\ngit stash\n\n");

    const out = runZshProbe(
      `
      BUFFER="git st"
      COLUMNS=60
      __sw_suggest
      print -r -- "n:\${#__sw_suggestions}"
      print -r -- "c1:\${__sw_suggestions[1]}"
      print -r -- "s1:[\${__sw_sources[1]}]"
      print -r -- "$POSTDISPLAY"
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );

    expect(out.stderr).toBe("");
    expect(out.stdout).toContain("n:2");
    expect(out.stdout).toContain("c1:git status");
    expect(out.stdout).toContain("s1:[]");
    expect(out.stdout).not.toContain("history");
  });

  test("a command containing a tab survives the split intact", () => {
    const daemon = startFakeDaemon("history\techo a\tb\n\n");

    const out = runZshProbe(
      `
      BUFFER="ec"
      __sw_suggest
      print -r -- "s1:\${__sw_sources[1]}"
      print -r -- "c1:[\${__sw_suggestions[1]}]"
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );

    expect(out.stdout).toContain("s1:history");
    expect(out.stdout).toContain("c1:[echo a\tb]");
  });

  test("Tab then Enter runs the command the daemon sent", () => {
    const daemon = startFakeDaemon("history\tgit status\ncommon\tgit stash\n\n");

    const out = runZshProbe(
      `
      BUFFER="git st"
      __sw_suggest
      __sw_next
      __sw_accept_line
      print -r -- "buf:\$BUFFER"
    `,
      { SHELLWISE_SOCKET: daemon.socket }
    );

    expect(out.stdout).toContain("buf:git status");
  });
});
