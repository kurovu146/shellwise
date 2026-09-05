import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let handleRequest: (raw: string) => string;

beforeAll(async () => {
  // A throwaway data dir: this test must never touch the real history.
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "sw-suggest-"));

  const server = await import("../../src/daemon/server");
  const { insertCommand } = await import("../../src/db/queries");

  server.initPreparedStatements();
  insertCommand({ command: "git status", exit_code: 0 });
  insertCommand({ command: "git stash pop", exit_code: 0 });

  handleRequest = server.handleRequest;
});

describe("SUGGEST reply", () => {
  test("an old shell gets bare commands, exactly as before", () => {
    const reply = handleRequest("SUGGEST\tgit\t5");
    const lines = reply.trimEnd().split("\n");
    expect(lines).toContain("git status");
    expect(reply).not.toContain("history\t");
    expect(reply.endsWith("\n\n")).toBe(true);
  });

  test("a v2 shell learns which lines came from history", () => {
    const reply = handleRequest("SUGGEST\tgit\t5\tv2");
    const lines = reply.trimEnd().split("\n");
    expect(lines).toContain("history\tgit status");
    expect(lines).toContain("history\tgit stash pop");
  });

  test("a v2 shell learns which lines are built-in common commands", () => {
    const reply = handleRequest("SUGGEST\tdock\t5\tv2");
    const lines = reply.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    // Nothing docker-ish was inserted above, so every hit is a common command.
    for (const line of lines) expect(line.startsWith("common\t")).toBe(true);
  });

  // A reply with no body is still a whole frame. Clients find the end of a
  // reply by looking for the blank-line terminator ("\n\n"); a bare "\n" never
  // completes one, so it stays in the read buffer and the NEXT reply is glued
  // onto its tail. The shell then labels that answer with the previous line,
  // decides it no longer matches what is on screen, and drops it.
  test("a query with no hits still terminates the reply", () => {
    expect(handleRequest("SUGGEST\tzzzznotacommand\t5\tv2")).toBe("\n\n");
  });

  test("a query too short to answer still terminates the reply", () => {
    expect(handleRequest("SUGGEST\tg\t5\tv2")).toBe("\n\n");
  });

  test("an unparseable request still terminates the reply", () => {
    expect(handleRequest("NOPE\tgarbage")).toBe("\n\n");
  });

  test("an empty reply does not swallow the next one on the same connection", () => {
    // Exactly what a shell reads off the socket: two answers, back to back.
    const stream =
      handleRequest("SUGGEST\tzzzznotacommand\t5\tv2") + handleRequest("SUGGEST\tgit\t5\tv2");
    const frames = stream.split("\n\n").slice(0, -1);
    expect(frames.length).toBe(2);
    expect(frames[0]).toBe("");
    expect(frames[1]).toContain("history\tgit status");
  });
});
