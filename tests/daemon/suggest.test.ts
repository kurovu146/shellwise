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

  test("a query with no hits still terminates the reply", () => {
    expect(handleRequest("SUGGEST\tzzzznotacommand\t5\tv2")).toBe("\n");
  });
});
