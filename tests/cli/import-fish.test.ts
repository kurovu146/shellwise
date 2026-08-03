import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * `os.homedir()` is resolved once when the process starts, so setting
 * process.env.HOME here would not move it — an earlier version of this test
 * happily read the developer's real fish_history. The parser is therefore
 * called with an explicit path, and the HOME-dependent wiring is checked in a
 * subprocess that gets HOME through its environment.
 */
let importFishHistory: (
  path: string,
  existing: Set<string>,
  seen: Set<string>
) => { imported: number; skipped: number };
let getDb: () => { query: (sql: string) => { all: () => { command: string }[] } };

const home = mkdtempSync(join(tmpdir(), "sw-fishimp-"));
const historyPath = join(home, ".local", "share", "fish", "fish_history");

beforeAll(async () => {
  process.env.XDG_DATA_HOME = join(home, "data");

  mkdirSync(join(home, ".local", "share", "fish"), { recursive: true });
  // Real fish_history shape, copied from an actual file.
  writeFileSync(
    historyPath,
    [
      "- cmd: git status",
      "  when: 1785748447",
      "- cmd: echo hello\\nworld",
      "  when: 1785748480",
      "- cmd: cd /tmp",
      "  when: 1785748481",
      "  paths:",
      "    - /tmp",
      "- cmd: x",
      "  when: 1785748482",
    ].join("\n")
  );

  ({ importFishHistory } = await import("../../src/cli/import"));
  ({ getDb } = await import("../../src/db/connection"));
});

describe("importFishHistory", () => {
  test("reads commands and skips the metadata lines around them", () => {
    const result = importFishHistory(historyPath, new Set(), new Set());
    const commands = getDb().query("SELECT command FROM command_stats").all().map((r) => r.command);

    expect(commands).toContain("git status");
    expect(commands).toContain("cd /tmp");
    // fish writes a newline as `\n`. Unescaping it matters even though
    // insertCommand then flattens control characters to spaces: without it the
    // stored command would carry a literal backslash-n.
    expect(commands).toContain("echo hello world");
    expect(commands.some((c) => c.includes("\\n"))).toBe(false);
    // "x" is one character — below the two-character floor.
    expect(commands).not.toContain("x");
    expect(commands.some((c) => c.startsWith("when:"))).toBe(false);
    expect(commands.some((c) => c.includes("paths"))).toBe(false);
    expect(result.imported).toBe(3);
  });

  test("a second pass imports nothing new", () => {
    const existing = new Set<string>();
    importFishHistory(historyPath, existing, existing);
    const again = importFishHistory(historyPath, existing, existing);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(3);
  });
});

describe("sw import fish", () => {
  test("finds fish_history under the home directory it is given", () => {
    const p = Bun.spawnSync(
      [process.execPath, "run", "src/index.ts", "import", "fish"],
      {
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: join(home, "data-cli"),
        },
      }
    );
    const out = p.stdout.toString();
    expect(out).toContain("Imported 3 commands");
  });
});
