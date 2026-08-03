/**
 * shellwise used to drop every command starting with `sw` or `shellwise`, to
 * keep its own plumbing out of the history. But the plumbing never travels this
 * path: suggestions go over the socket, and `Ctrl+R` runs inside a widget, so
 * precmd never sees them. All the filter did was hide commands the user typed
 * on purpose — `sw ssh <host>` above all.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let handleRequest: (raw: string) => string;
let runAdd: (opts: { command: string; exitCode?: number }) => void;
let getDb: () => { query: (sql: string) => { all: () => { command: string }[] } };

function add(command: string): string {
  return handleRequest(`ADD\t${command}\t/tmp\t0\t12\tsession\tzsh`);
}

function stored(): string[] {
  return getDb()
    .query("SELECT command FROM command_stats")
    .all()
    .map((r) => r.command);
}

beforeAll(async () => {
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "sw-addfilter-"));
  const server = await import("../../src/daemon/server");
  server.initPreparedStatements();
  handleRequest = server.handleRequest;
  ({ runAdd } = await import("../../src/cli/add"));
  ({ getDb } = await import("../../src/db/connection"));
});

describe("recording shellwise's own commands", () => {
  test("keeps a command the user typed on purpose", () => {
    add("sw ssh vnarena-be");
    expect(stored()).toContain("sw ssh vnarena-be");
  });

  test("keeps the long form too", () => {
    add("shellwise import zsh");
    expect(stored()).toContain("shellwise import zsh");
  });

  test("keeps them on the CLI fallback path as well", () => {
    // bash records through `shellwise add`, and so does zsh when the socket
    // write fails — the filter has to be gone from both.
    runAdd({ command: "sw stats", exitCode: 0 });
    expect(stored()).toContain("sw stats");
  });

  test("still refuses what was never worth recording", () => {
    add(" leading-space-command");
    add("x");
    expect(stored()).not.toContain(" leading-space-command");
    expect(stored()).not.toContain("x");
  });

  test("still refuses a command that failed", () => {
    expect(handleRequest("ADD\tsw ssh broken-host\t/tmp\t1\t12\tsession\tzsh")).toBe("OK\n\n");
    expect(stored()).not.toContain("sw ssh broken-host");
  });
});
