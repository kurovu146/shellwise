import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Same isolation rules as import-fish.test.ts: the parser gets an explicit
 * path, XDG_DATA_HOME points at a temp dir so the real DB is never opened, and
 * the HOME/APPDATA-dependent wiring runs in a subprocess.
 */
type Result = { imported: number; skipped: number };
let importPowerShellHistory: (path: string, existing: Set<string>, seen: Set<string>) => Result;
let powerShellHistoryPaths: (env: {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
}) => string[];
let getDb: () => { query: (sql: string) => { all: () => { command: string }[] } };

const root = mkdtempSync(join(tmpdir(), "sw-psimp-"));
const SAMPLE = ["git status", "Get-ChildItem `", "  -Recurse", "x", "git status"];

function writeSample(name: string, content: string): string {
  const p = join(root, name);
  writeFileSync(p, content);
  return p;
}

function stored(): string[] {
  return getDb().query("SELECT command FROM command_stats").all().map((r) => r.command);
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
  test("joins backtick continuations, ignores 1-char lines, skips duplicates", () => {
    const path = writeSample("lf.txt", SAMPLE.join("\n") + "\n");
    const r = importPowerShellHistory(path, new Set(), new Set());
    expect(r).toEqual({ imported: 2, skipped: 1 });
    const cmds = stored();
    expect(cmds).toContain("git status");
    // insertCommand flattens control characters, so the newline is stored as a space.
    expect(cmds.some((c) => c.startsWith("Get-ChildItem `") && c.endsWith("-Recurse"))).toBe(true);
    expect(cmds).not.toContain("x");
  });

  test("a second pass imports nothing", () => {
    const path = writeSample("lf2.txt", SAMPLE.join("\n") + "\n");
    const existing = new Set<string>();
    importPowerShellHistory(path, existing, existing);
    const again = importPowerShellHistory(path, existing, existing);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(3);
  });

  test("CRLF line endings give the same result", () => {
    const path = writeSample("crlf.txt", SAMPLE.join("\r\n") + "\r\n");
    expect(importPowerShellHistory(path, new Set(), new Set())).toEqual({ imported: 2, skipped: 1 });
  });

  test("a leading UTF-8 BOM is stripped from the first command", () => {
    const path = writeSample("bom.txt", "\uFEFFbom-first-cmd\nbom-second-cmd\n");
    const r = importPowerShellHistory(path, new Set(), new Set());
    expect(r.imported).toBe(2);
    expect(stored()).toContain("bom-first-cmd");
  });

  test("a trailing backtick on the last line is flushed, not lost", () => {
    const path = writeSample("trail.txt", "dangling-cmd `");
    expect(importPowerShellHistory(path, new Set(), new Set()).imported).toBe(1);
    expect(stored().some((c) => c.startsWith("dangling-cmd"))).toBe(true);
  });

  test("a line that is only a backtick, and an empty file, import nothing", () => {
    const only = writeSample("only.txt", "`\n");
    expect(importPowerShellHistory(only, new Set(), new Set())).toEqual({ imported: 0, skipped: 0 });
    const empty = writeSample("empty.txt", "");
    expect(importPowerShellHistory(empty, new Set(), new Set())).toEqual({ imported: 0, skipped: 0 });
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
    const appData = join(root, "appdata");
    const dir = join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ConsoleHost_history.txt"), "cli-one\ncli-two\n");
    // Linux/macOS location, in case the test runs there.
    const posixDir = join(root, ".local", "share", "powershell", "PSReadLine");
    mkdirSync(posixDir, { recursive: true });
    writeFileSync(join(posixDir, "ConsoleHost_history.txt"), "cli-one\ncli-two\n");

    const p = Bun.spawnSync([process.execPath, "run", "src/index.ts", "import", "powershell"], {
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        APPDATA: appData,
        XDG_DATA_HOME: join(root, "data-cli"),
        XDG_CONFIG_HOME: join(root, "config-cli"),
        SHELLWISE_DAEMON_SOCKET: join(root, "d.sock"),
      },
    });
    expect(p.stdout.toString()).toContain("Imported 2 commands");
  });
});
