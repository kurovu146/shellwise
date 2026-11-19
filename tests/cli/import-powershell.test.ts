import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Same isolation rules as import-fish.test.ts: the parser gets an explicit
 * path, XDG_DATA_HOME points at a temp dir so the real DB is never opened, and
 * the HOME/APPDATA-dependent wiring runs in a subprocess.
 *
 * Fixtures use the real PSReadLine file format: a trailing backtick is the
 * "entry continues on the next line" marker; a backtick the user typed at the
 * end of a line is written as two.
 */
type Result = { imported: number; skipped: number; multiline: number };
let importPowerShellHistory: (path: string, existing: Set<string>, seen: Set<string>) => Result;
let powerShellHistoryPaths: (env: {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
}) => string[];
let getDb: () => {
  query: (sql: string) => { all: () => { command: string; shell: string | null }[] };
};

const root = mkdtempSync(join(tmpdir(), "sw-psimp-"));
const TWO_LINE = ["git status", "Get-ChildItem `", "  -Recurse", "x", "git status"];

function writeSample(name: string, content: string | Buffer): string {
  const p = join(root, name);
  writeFileSync(p, content);
  return p;
}

function stored(): string[] {
  return getDb().query("SELECT command FROM command_stats").all().map((r) => r.command);
}

function runCli(args: string[], dir: string, appData: string): string {
  const p = Bun.spawnSync([process.execPath, "run", "src/index.ts", ...args], {
    env: {
      ...process.env,
      HOME: dir,
      // os.homedir() reads USERPROFILE on Windows.
      USERPROFILE: dir,
      APPDATA: appData,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CONFIG_HOME: join(dir, "config"),
      SHELLWISE_DAEMON_SOCKET: join(dir, "d.sock"),
    },
  });
  return p.stdout.toString();
}

/** Lay out a PSReadLine history file for both the win32 and the POSIX lookup. */
function placeHistory(dir: string, content: string): string {
  const appData = join(dir, "appdata");
  for (const base of [
    join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine"),
    join(dir, ".local", "share", "powershell", "PSReadLine"),
  ]) {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "ConsoleHost_history.txt"), content);
  }
  return appData;
}

function frequencies(dir: string): { command: string; frequency: number }[] {
  const db = new Database(join(dir, "data", "shellwise", "history.db"), { readonly: true });
  try {
    return db.query("SELECT command, frequency FROM command_stats ORDER BY command").all() as {
      command: string;
      frequency: number;
    }[];
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  process.env.XDG_DATA_HOME = join(root, "data");
  ({ importPowerShellHistory, powerShellHistoryPaths } = await import("../../src/cli/import"));
  ({ getDb } = await import("../../src/db/connection"));
});

afterAll(() => {
  // Bun ignores rmSync's retry options; the DB handle can still be open.
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(100);
    }
  }
});

describe("importPowerShellHistory", () => {
  test("imports single-line entries only; multi-line entries are left out and not counted as duplicates", () => {
    const path = writeSample("lf.txt", TWO_LINE.join("\n") + "\n");
    const r = importPowerShellHistory(path, new Set(), new Set());
    expect(r).toEqual({ imported: 1, skipped: 1, multiline: 1 });
    const cmds = stored();
    expect(cmds).toContain("git status");
    expect(cmds.some((c) => c.includes("Get-ChildItem") || c.includes("-Recurse"))).toBe(false);
    expect(cmds).not.toContain("x");
  });

  test("rows are tagged with the powershell shell", () => {
    const path = writeSample("tag.txt", "tag-check-cmd\n");
    importPowerShellHistory(path, new Set(), new Set());
    const row = getDb()
      .query("SELECT command, shell FROM commands")
      .all()
      .find((r) => r.command === "tag-check-cmd");
    expect(row?.shell).toBe("powershell");
  });

  test("an entry the user typed with a trailing backtick (written as two) is a 2-line entry and left out", () => {
    const path = writeSample("typed.txt", "Get-ChildItem ``\n-Recurse\nkeep-me-cmd\n");
    expect(importPowerShellHistory(path, new Set(), new Set())).toEqual({
      imported: 1,
      skipped: 0,
      multiline: 1,
    });
    expect(stored()).toContain("keep-me-cmd");
  });

  test("a three-line entry is left out and the normal line after it is imported", () => {
    const path = writeSample("three.txt", "foreach ($i in 1..2) {`\n  Write-Host a`\n}\nafter-three-cmd\n");
    expect(importPowerShellHistory(path, new Set(), new Set())).toEqual({
      imported: 1,
      skipped: 0,
      multiline: 1,
    });
    expect(stored()).toContain("after-three-cmd");
    expect(stored().some((c) => c.includes("foreach"))).toBe(false);
  });

  test("CRLF line endings give the same result", () => {
    const path = writeSample("crlf.txt", TWO_LINE.join("\r\n") + "\r\n");
    // "git status" was stored by the first test, but fresh sets know nothing
    // about it, so here it counts as imported.
    expect(importPowerShellHistory(path, new Set(), new Set())).toEqual({
      imported: 1,
      skipped: 1,
      multiline: 1,
    });
  });

  test("a leading UTF-8 BOM does not end up in the first stored command", () => {
    const path = writeSample("bom.txt", "\uFEFFbom-first-cmd\nbom-second-cmd\n");
    expect(importPowerShellHistory(path, new Set(), new Set()).imported).toBe(2);
    const cmds = stored();
    expect(cmds).toContain("bom-first-cmd");
    expect(cmds.some((c) => c.includes("\uFEFF"))).toBe(false);
  });

  test("UTF-16 LE and BE files are decoded", () => {
    const le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("utf16le-one\nutf16le-two\n", "utf16le"),
    ]);
    expect(importPowerShellHistory(writeSample("le.txt", le), new Set(), new Set()).imported).toBe(2);
    const be = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from("utf16be-one\nutf16be-two\n", "utf16le").swap16(),
    ]);
    expect(importPowerShellHistory(writeSample("be.txt", be), new Set(), new Set()).imported).toBe(2);
    const cmds = stored();
    for (const c of ["utf16le-one", "utf16le-two", "utf16be-one", "utf16be-two"]) {
      expect(cmds).toContain(c);
    }
  });

  test("a file ending mid-continuation drops the unterminated tail", () => {
    for (const tail of ["", "\n"]) {
      const path = writeSample("trail.txt", "before-tail-cmd\ndangling-cmd `" + tail);
      expect(importPowerShellHistory(path, new Set(), new Set())).toEqual({
        imported: 1,
        skipped: 0,
        multiline: 0,
      });
    }
    expect(stored().some((c) => c.startsWith("dangling-cmd"))).toBe(false);
  });

  test("a line that is only a backtick, and an empty file, import nothing", () => {
    const only = writeSample("only.txt", "`\n");
    expect(importPowerShellHistory(only, new Set(), new Set())).toEqual({ imported: 0, skipped: 0, multiline: 0 });
    const empty = writeSample("empty.txt", "");
    expect(importPowerShellHistory(empty, new Set(), new Set())).toEqual({ imported: 0, skipped: 0, multiline: 0 });
  });
});

describe("powerShellHistoryPaths", () => {
  test("win32 uses APPDATA", () => {
    expect(
      powerShellHistoryPaths({
        platform: "win32",
        home: "C:\\Users\\A",
        appData: "C:\\Users\\A\\AppData\\Roaming",
      })
    ).toEqual([
      join("C:\\Users\\A\\AppData\\Roaming", "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
    ]);
  });

  test("win32 without APPDATA falls back to home\\AppData\\Roaming", () => {
    expect(powerShellHistoryPaths({ platform: "win32", home: "C:\\Users\\A" })).toEqual([
      join("C:\\Users\\A", "AppData", "Roaming", "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
    ]);
  });

  test("linux and darwin use ~/.local/share/powershell", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(powerShellHistoryPaths({ platform, home: "/home/a" })).toEqual([
        join("/home/a", ".local", "share", "powershell", "PSReadLine", "ConsoleHost_history.txt"),
      ]);
    }
  });
});

describe("sw import powershell", () => {
  test("reads the file under the APPDATA it is given", () => {
    const dir = join(root, "cli-explicit");
    const appData = placeHistory(dir, "cli-one\ncli-two\n");
    expect(runCli(["import", "powershell"], dir, appData)).toContain("Imported 2 commands");
  });

  test("with no argument it also imports the PowerShell history", () => {
    const dir = join(root, "cli-noarg");
    const appData = placeHistory(dir, "noarg-one\nnoarg-two\n");
    expect(runCli(["import"], dir, appData)).toContain("Imported 2 commands");
  });

  test("a second run in a separate process imports nothing and leaves frequency alone", () => {
    const dir = join(root, "cli-idem");
    // A TAB is flattened by insertCommand, so it is the case where the hash
    // that is checked and the hash that is stored used to differ.
    const appData = placeHistory(dir, "Write-Host\tone\nplain-cmd\n");

    expect(runCli(["import", "powershell"], dir, appData)).toContain("Imported 2 commands");
    const before = frequencies(dir);
    expect(before).toEqual([
      { command: "Write-Host one", frequency: 1 },
      { command: "plain-cmd", frequency: 1 },
    ].sort((a, b) => (a.command < b.command ? -1 : 1)));

    expect(runCli(["import", "powershell"], dir, appData)).toContain("Imported 0 commands. Skipped 2");
    expect(frequencies(dir)).toEqual(before);
  });
});
