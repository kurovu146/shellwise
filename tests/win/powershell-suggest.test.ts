import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HELPER_HASH } from "../../src/cli/init/powershell-helper.cs";
import { drive, killTree, removeDir, startHiddenConsole, waitForExit, type Step } from "./console-harness";

const REPO = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO, "src", "index.ts");
// A cold pwsh with PSReadLine, plus compiling the helper on first load.
const TEST_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 30_000;
const HAS_PWSH = Bun.which("pwsh") !== null;
const TUI_MARK = "Esc:cancel";
// The last one ends in a word Tab completion would still change: selecting it
// must not also complete it (the old Tab job runs only when no list moved).
const SEEDED = ["git status", "git stash pop", "git log --oneline", "git stage; Get-Uptim"];

// PSReadLine as it comes (HistoryAndPlugin, inline view), with predictions
// turned off, and as the repo owner's profile sets it, with a PSReadLine
// history that shares the list with ours. All bind Tab to MenuComplete first,
// which must keep working when no list is showing.
const CONFIGS: Record<string, { options: string[]; owner: boolean }> = {
  "PSReadLine's defaults": { options: [], owner: false },
  "predictions off": { options: ["Set-PSReadLineOption -PredictionSource None"], owner: false },
  "the owner's profile (HistoryAndPlugin, ListView) and a PSReadLine history": {
    options: ["Set-PSReadLineOption -PredictionSource HistoryAndPlugin -PredictionViewStyle ListView"],
    owner: true,
  },
};
// The owner's PSReadLine history: one command only there, and one that is in
// the shellwise DB too, as it is when both record the same shell.
const PSREADLINE_ONLY = "git stash list";
const IN_BOTH = "git status";

const enter: Step = { type: "key", value: "enter" };
const escape: Step = { type: "key", value: "escape" };
const typeLine = (value: string): Step[] => [{ type: "text", value }, enter];
const promptIndex = (rows: string[]) => rows.findLastIndex((r) => /^PS>( |$)/.test(r));
const promptText = (rows: string[]) => rows[promptIndex(rows)] ?? "";
const same = (a: string[], b: string[]) => a.length === b.length && a.every((r, i) => r === b[i]);
/** The items of PSReadLine's list view below the prompt: `> text   [source]`. */
const listItems = (rows: string[]) =>
  rows
    .slice(promptIndex(rows) + 1)
    .map((r) => r.match(/^> (.+?)\s+\[(\w+)\]$/))
    .filter((m) => m !== null)
    .map((m) => ({ text: m[1], source: m[2] }));
// SW_E2E_DUMP=1 prints the screens the assertions look at; quiet otherwise.
const dump = (title: string, rows: string[]) => {
  if (process.env.SW_E2E_DUMP) console.log(`--- ${title}\n${rows.join("\n").trimEnd()}`);
};

/** Pids of every `daemon _run` of this checkout, from the process table. */
function daemonPids(): number[] {
  const marker = `${ENTRY} daemon _run`.toLowerCase();
  const query = `Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
  const out = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", query]).stdout.toString();
  return out
    .split(/\r?\n/)
    .filter((l) => l.toLowerCase().includes(marker))
    .map((l) => parseInt(l));
}

/** Poll the window of `pid` until `done` holds on two reads in a row. */
function waitForScreen(pid: number, what: string, done: (rows: string[]) => boolean): string[] {
  const deadline = Date.now() + 10_000;
  let prev: string[] = [];
  while (true) {
    const rows = drive(pid, [{ type: "screen", label: what }])[0].rows;
    if (done(rows) && same(prev, rows)) return rows;
    prev = rows;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last screen:\n${rows.join("\n")}`);
    Bun.sleepSync(50);
  }
}

/**
 * A temp dir with a `shellwise.cmd` shim first on PATH, a seeded history DB
 * and a running daemon, all isolated from the real ones. The data dir has a
 * space and a non-ASCII letter: the DLL cache is there.
 */
class Sandbox {
  dir = mkdtempSync(join(tmpdir(), "sw-ps-suggest-"));
  env: Record<string, string>;
  psDir: string;
  private foreign = new Set(daemonPids());

  constructor(seed: string[]) {
    const bin = join(this.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "shellwise.cmd"), `@"${process.execPath}" "${ENTRY}" %*\r\n`);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const data = join(this.dir, "data ệ");
    this.env = {
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: join(this.dir, "config"),
      SHELLWISE_DAEMON_SOCKET: join(this.dir, "daemon.sock"),
      [pathKey]: `${bin};${process.env[pathKey]}`,
    };
    this.psDir = join(data, "shellwise", "ps");
    for (const command of seed) this.cli(["add", command]);
    this.cli(["daemon", "start"]);
  }

  cli(args: string[]): string {
    return Bun.spawnSync([process.execPath, ENTRY, ...args], { env: { ...process.env, ...this.env } }).stdout.toString();
  }

  /** A hidden pwsh running `profileLines` (each its own line) and staying open. */
  startShell(profileLines: string[], psreadlineHistory: string[] = []): number {
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const history = join(this.dir, `psreadline-${name}.txt`);
    writeFileSync(history, psreadlineHistory.map((l) => `${l}\r\n`).join(""));
    const profile = join(this.dir, `profile-${name}.ps1`);
    const lines = [
      "[Console]::SetWindowSize(120, 30)",
      // Keep PSReadLine off the user's real history file.
      `Set-PSReadLineOption -HistorySavePath '${history}'`,
      ...profileLines,
    ];
    writeFileSync(profile, lines.join("\r\n") + "\r\n");
    return startHiddenConsole("pwsh", ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", profile], this.env);
  }

  /**
   * Stop the daemon, and any daemon of this checkout started since (one a
   * failed test left behind would hold the dir), then remove the dir.
   */
  cleanup(): void {
    this.cli(["daemon", "stop"]);
    for (const pid of daemonPids().filter((p) => !this.foreign.has(p))) killTree(pid);
    removeDir(this.dir);
  }
}

const INIT = "shellwise init powershell | Out-String | Invoke-Expression";

describe.skipIf(process.platform !== "win32" || !HAS_PWSH)("PowerShell suggestions while typing", () => {
  for (const [name, config] of Object.entries(CONFIGS)) describeConfig(name, config.options, config.owner);
});

function describeConfig(name: string, options: string[], owner: boolean): void {
  describe(`pwsh with ${name}`, () => {
    let box: Sandbox;
    let pid: number | null = null;

    const suggest = (query: string) => box.cli(["suggest", "--query", query, "--limit", "20"]).split("\n");

    function expectRecorded(query: string, command: string): void {
      const deadline = Date.now() + 10_000;
      while (!suggest(query).includes(command)) {
        if (Date.now() > deadline) throw new Error(`never recorded: ${command}\nfound: ${suggest(query).join(" | ")}`);
        Bun.sleepSync(100);
      }
    }

    /** Press `key`, then wait until the prompt line reads `line`. */
    const press = (key: "tab" | "shift-tab", line: string) => {
      drive(pid!, [{ type: "key", value: key }]);
      return waitForScreen(pid!, `${key} -> ${line}`, (rows) => promptText(rows) === line);
    };

    /** Type `text` on an empty line and wait for the list to settle. */
    const typeAndWaitForList = (text: string, withList: boolean) => {
      drive(pid!, [escape, escape, { type: "text", value: text }]);
      return waitForScreen(pid!, `typed ${text}`, (rows) => promptText(rows) === `PS> ${text}` && listItems(rows).length > 0 === withList);
    };

    const baseProfile = () => [...options, "Set-PSReadLineKeyHandler -Chord Tab -Function MenuComplete", `function prompt { "PS> " }`, INIT];
    const history = owner ? [PSREADLINE_ONLY, IN_BOTH] : [];

    beforeAll(() => {
      box = new Sandbox(SEEDED);
      pid = box.startShell(
        [
          ...baseProfile(),
          // No process can record from here on: only the socket can (restored below).
          "$global:swBin = $global:__sw.BinPath; $global:__sw.BinPath = $null",
          `"ready helper=$($global:__sw.HasHelper) source=$((Get-PSReadLineOption).PredictionSource) view=$((Get-PSReadLineOption).PredictionViewStyle) errors=$($Error.Count)"`,
        ],
        history
      );
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      if (pid !== null) killTree(pid);
      pid = null;
      box.cleanup();
    }, SETUP_TIMEOUT_MS);

    test("loads cleanly with the helper, compiled into a DLL under the data dir", () => {
      const [loaded] = drive(pid!, [
        { type: "waitFor", text: "PS>", timeoutMs: 20_000 },
        { type: "screen", label: "loaded" },
      ]);
      dump(`${name}: loaded`, loaded.lines);
      // Predictions off become ours only; a source with history keeps it.
      const source = options.some((o) => o.includes("None")) ? "Plugin" : "HistoryAndPlugin";
      expect(loaded.lines).toEqual([`ready helper=True source=${source} view=ListView errors=0`, "PS>"]);
      expect(readdirSync(box.psDir)).toEqual([expect.stringMatching(new RegExp(`^shellwise-helper-${HELPER_HASH}-7\\.\\d+\\.dll$`))]);
    }, TEST_TIMEOUT_MS);

    test("lists the daemon's suggestions as you type; with the owner's history, each command once", () => {
      const rows = typeAndWaitForList("git st", true);
      dump(`${name}: typed git st`, rows);
      const items = listItems(rows);
      expect(items).toContainEqual({ text: "git stash pop", source: "shellwise" });
      expect(items.filter((i) => i.text === IN_BOTH)).toHaveLength(1);
      if (owner) expect(items).toContainEqual({ text: PSREADLINE_ONLY, source: "History" });
      else expect(items.every((i) => i.source === "shellwise")).toBe(true);
      expect(new Set(items.map((i) => i.text)).size).toBe(items.length);
    }, TEST_TIMEOUT_MS);

    test("Tab and Shift+Tab walk the whole list and come back to what was typed", () => {
      const items = listItems(typeAndWaitForList("git st", true)).map((i) => i.text);
      expect(items.length).toBeGreaterThanOrEqual(owner ? 3 : 2);
      const first = press("tab", `PS> ${items[0]}`);
      const second = press("tab", `PS> ${items[1]}`);
      const back = press("shift-tab", `PS> ${items[0]}`);
      // The list stays open while moving in it.
      for (const rows of [first, second, back]) expect(listItems(rows).map((i) => i.text)).toEqual(items);
      for (const item of items.slice(1)) press("tab", `PS> ${item}`);
      const wrapped = press("tab", "PS> git st");
      dump(`${name}: Tab`, first);
      dump(`${name}: Tab, Tab`, second);
      dump(`${name}: Tab, Tab, Shift+Tab`, back);
      dump(`${name}: past the last item`, wrapped);
    }, TEST_TIMEOUT_MS);

    test("Tab and Shift+Tab still complete when no list is showing", () => {
      typeAndWaitForList("Get-ChildIt", false);
      const tab = press("tab", "PS> Get-ChildItem");
      typeAndWaitForList("Get-ChildIt", false);
      press("shift-tab", "PS> Get-ChildItem");
      dump(`${name}: Tab on Get-ChildIt`, tab);
    }, TEST_TIMEOUT_MS);

    test("records a command over the socket, with no process to start", () => {
      drive(pid!, [escape, escape, ...typeLine("echo predictor-roundtrip")]);
      expectRecorded("echo predictor", "echo predictor-roundtrip");
      const db = new Database(join(box.env.XDG_DATA_HOME, "shellwise", "history.db"), { readonly: true });
      try {
        const row = db.query("SELECT shell, exit_code, session_id FROM commands WHERE command = ?").get("echo predictor-roundtrip");
        expect(row).toEqual({ shell: "powershell", exit_code: 0, session_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      } finally {
        db.close();
      }
    }, TEST_TIMEOUT_MS);

    test("with the daemon gone: no suggestions of ours and no error on screen", () => {
      expect(box.cli(["daemon", "stop"])).toContain("Daemon stopped");
      const rows = typeAndWaitForList("git st", owner);
      dump(`${name}: git st with the daemon down`, rows);
      expect(listItems(rows).filter((i) => i.source === "shellwise")).toEqual([]);
      // (The ready line reports "errors=0" itself.)
      expect(rows.filter((r) => /exception|error/i.test(r) && !r.startsWith("ready "))).toEqual([]);
    }, TEST_TIMEOUT_MS);

    test("with the daemon gone, commands are still recorded and the daemon is started again, once", () => {
      // Both commands find no daemon, and each prompt starts one.
      drive(pid!, [escape, escape, ...typeLine("$global:__sw.BinPath = $global:swBin"), ...typeLine("echo fallback-roundtrip")]);
      expectRecorded("echo fallback", "echo fallback-roundtrip");
      const deadline = Date.now() + 10_000;
      while (!box.cli(["daemon", "status"]).includes("Daemon running") && Date.now() < deadline) Bun.sleepSync(100);
      expect(box.cli(["daemon", "status"])).toContain("Daemon running");

      // Only one of them kept running: stopped, it lets go of the data dir
      // (its cwd, the DB), and nothing else holds it.
      expect(box.cli(["daemon", "stop"])).toContain("Daemon stopped");
      const data = join(box.env.XDG_DATA_HOME, "shellwise");
      renameSync(data, `${data}-moved`);
      renameSync(`${data}-moved`, data);
      expect(box.cli(["daemon", "start"])).toContain("Daemon started");
    }, TEST_TIMEOUT_MS);

    test("Ctrl+R replaces the line while the list is showing", () => {
      typeAndWaitForList("git st", true);
      drive(pid!, [{ type: "key", value: "ctrl-r" }, { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 }, enter]);
      const after = waitForScreen(pid!, "after Ctrl+R", (rows) => !rows.some((r) => r.includes(TUI_MARK)) && /^PS> git/.test(promptText(rows)));
      dump(`${name}: after Ctrl+R + Enter`, after);
      expect(["PS> git status", "PS> git stash pop"]).toContain(promptText(after));
    }, TEST_TIMEOUT_MS);

    test("loading the script again keeps the list, Tab's old job, and adds no error", () => {
      drive(pid!, [escape, escape, ...typeLine(`${INIT}; "reloaded errors=$($Error.Count) tab=$($global:__sw.TabFallback)"`)]);
      const reloaded = waitForScreen(pid!, "reloaded", (rows) => rows.some((r) => r.startsWith("reloaded ")) && promptText(rows) === "PS>");
      expect(reloaded.filter((r) => r.startsWith("reloaded "))).toEqual(["reloaded errors=0 tab=MenuComplete"]);
      typeAndWaitForList("Get-ChildIt", false);
      press("tab", "PS> Get-ChildItem");
      const items = listItems(typeAndWaitForList("git st", true));
      expect(items).toContainEqual({ text: "git stash pop", source: "shellwise" });
      press("tab", `PS> ${items[0].text}`);
    }, TEST_TIMEOUT_MS);

    test("a second shell loads the cached DLL and leaves no temp file", () => {
      drive(pid!, [escape, escape, ...typeLine("exit")]);
      expect(waitForExit(pid!, 10_000)).toBe(true);
      pid = null;
      const [dll] = readdirSync(box.psDir);
      const built = statSync(join(box.psDir, dll)).mtimeMs;
      // (Compared in the shell: the path is too long for a row, and not ASCII.)
      pid = box.startShell([
        ...baseProfile(),
        `"ready helper=$($global:__sw.HasHelper) cached=$([ShellwisePredictor].Assembly.Location -eq (Join-Path $global:__sw.DataDir 'ps\\${dll}')) errors=$($Error.Count)"`,
      ]);
      const rows = waitForScreen(pid, "second shell", (r) => promptText(r) === "PS>");
      dump(`${name}: second shell`, rows);
      expect(rows.filter((r) => r !== "")).toEqual(["ready helper=True cached=True errors=0", "PS>"]);
      expect(readdirSync(box.psDir)).toEqual([dll]);
      expect(statSync(join(box.psDir, dll)).mtimeMs).toBe(built);
    }, TEST_TIMEOUT_MS);
  });
}

// Tab's previous job, when it is not MenuComplete: PSReadLine's default
// TabCompleteNext, or a script block of the user's own; and a window too small
// for the list.
describe.skipIf(process.platform !== "win32" || !HAS_PWSH)("PowerShell: what Tab did before stays", () => {
  // Completing `gc zz` gives these one after the other; each completed line
  // has a list of its own, from this history.
  const FILES = ["zzalpha.txt", "zzbeta.txt", "zzgamma.txt"];
  let box: Sandbox;
  let work: string;
  const shells: number[] = [];

  beforeAll(() => {
    box = new Sandbox([...SEEDED, ...FILES.map((f) => `gc .\\${f} -Raw`)]);
    work = join(box.dir, "work");
    mkdirSync(work);
    for (const f of FILES) writeFileSync(join(work, f), "");
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    for (const pid of shells) killTree(pid);
    box.cleanup();
  }, SETUP_TIMEOUT_MS);

  const start = (lines: string[]) => {
    const pid = box.startShell([`Set-Location -LiteralPath '${work}'`, `function prompt { "PS> " }`, ...lines]);
    shells.push(pid);
    return pid;
  };
  const ready = (pid: number, what: string) =>
    waitForScreen(pid, what, (rows) => rows.some((r) => r.startsWith("ready ")) && promptText(rows) === "PS>");
  const readyLine = (rows: string[]) => rows.find((r) => r.startsWith("ready "));

  /** Type `gc zz`, then press each key in turn: the screen after each. */
  function completionCycle(pid: number, label: string, keys: ("tab" | "shift-tab")[]): string[][] {
    drive(pid, [{ type: "text", value: "gc zz" }]);
    let line = promptText(waitForScreen(pid, "typed gc zz", (rows) => promptText(rows) === "PS> gc zz"));
    const screens: string[][] = [];
    for (const key of keys) {
      const before = line;
      drive(pid, [{ type: "key", value: key }]);
      const rows = waitForScreen(pid, `${key} after ${before}`, (r) => promptText(r) !== before);
      line = promptText(rows);
      screens.push(rows);
      dump(`${label}: ${key} -> ${line}`, rows);
    }
    return screens;
  }

  test("Tab cycles through the completions as before, even when each completed line has a list", () => {
    const keys: ("tab" | "shift-tab")[] = ["tab", "tab", "tab", "tab", "shift-tab", "shift-tab"];
    const plain = start([`"ready plain"`]);
    ready(plain, "plain shell");
    const expected = completionCycle(plain, "without shellwise", keys).map(promptText);
    expect(expected).toEqual([
      "PS> gc .\\zzalpha.txt",
      "PS> gc .\\zzbeta.txt",
      "PS> gc .\\zzgamma.txt",
      "PS> gc .\\zzalpha.txt",
      "PS> gc .\\zzgamma.txt",
      "PS> gc .\\zzbeta.txt",
    ]);

    const ours = start([INIT, `"ready tab=$($global:__sw.TabFallback)"`]);
    expect(readyLine(ready(ours, "shellwise shell"))).toBe("ready tab=TabCompleteNext");
    const screens = completionCycle(ours, "with shellwise", keys);
    expect(screens.map(promptText)).toEqual(expected);
    // The case at stake: a list was showing for the completed line.
    expect(listItems(screens[0]).map((i) => i.text)).toContain("gc .\\zzalpha.txt -Raw");

    // Typing after a completion goes back to the list: after a space, Tab
    // selects the completed line's own history (completion would add a file).
    drive(ours, [{ type: "text", value: " " }, { type: "key", value: "tab" }]);
    const into = waitForScreen(ours, "space, Tab", (rows) => promptText(rows) === "PS> gc .\\zzbeta.txt -Raw");
    dump("with shellwise: space, Tab", into);

    // The same line typed again after a command ran is a new line: Tab goes
    // to its list first.
    drive(ours, [escape, escape, { type: "text", value: "gc zz" }, { type: "key", value: "tab" }]);
    waitForScreen(ours, "completed", (rows) => promptText(rows) === "PS> gc .\\zzalpha.txt");
    drive(ours, [enter, { type: "text", value: "gc .\\zzalpha.txt" }]);
    waitForScreen(ours, "typed again", (rows) => promptText(rows) === "PS> gc .\\zzalpha.txt" && listItems(rows).length > 0);
    drive(ours, [{ type: "key", value: "tab" }]);
    waitForScreen(ours, "Tab after a command", (rows) => promptText(rows) === "PS> gc .\\zzalpha.txt -Raw");
  }, TEST_TIMEOUT_MS);

  test("MenuComplete: the menu works as before, and Tab on the accepted line completes again", () => {
    /** Prompt lines: menu opened, moved, accepted, then Tab and a marker key. */
    const run = (lines: string[], label: string) => {
      const pid = start(["Set-PSReadLineKeyHandler -Chord Tab -Function MenuComplete", ...lines]);
      ready(pid, label);
      drive(pid, [{ type: "text", value: "gc zz" }]);
      waitForScreen(pid, "typed", (rows) => promptText(rows) === "PS> gc zz");
      drive(pid, [{ type: "key", value: "tab" }]);
      const opened = waitForScreen(pid, "menu", (rows) => promptText(rows) !== "PS> gc zz");
      drive(pid, [{ type: "key", value: "tab" }]);
      const moved = waitForScreen(pid, "moved", (rows) => promptText(rows) !== promptText(opened));
      drive(pid, [enter]);
      // The menu rows (the other candidates) go away.
      const accepted = waitForScreen(pid, "accepted", (rows) => !rows.some((r) => r.includes("zzgamma") && !r.startsWith("PS>")));
      // A Tab that changes nothing shows nothing: the marker shows it ran.
      drive(pid, [{ type: "key", value: "tab" }, { type: "text", value: "X" }]);
      const after = waitForScreen(pid, "Tab, X", (rows) => promptText(rows).endsWith("X"));
      dump(`${label}: menu`, opened);
      dump(`${label}: Tab, X`, after);
      return [opened, moved, accepted, after].map(promptText);
    };
    const expected = run([`"ready plain"`], "MenuComplete without shellwise");
    expect(expected).toEqual(["PS> gc .\\zzalpha.txt", "PS> gc .\\zzbeta.txt", "PS> gc .\\zzbeta.txt", "PS> gc .\\zzbeta.txtX"]);
    expect(run([INIT, `"ready ours"`], "MenuComplete with shellwise")).toEqual(expected);
  }, TEST_TIMEOUT_MS);

  test("a Tab bound to the user's own script block keeps its job; Shift+Tab still walks the list", () => {
    const pid = start([
      "Set-PSReadLineKeyHandler -Chord Tab -ScriptBlock { [Microsoft.PowerShell.PSConsoleReadLine]::Insert('<MY-TAB>') }",
      INIT,
      `"ready errors=$($Error.Count) tab=$((Get-PSReadLineKeyHandler -Chord Tab).Function) stab=$((Get-PSReadLineKeyHandler -Chord Shift+Tab).Function)"`,
    ]);
    const loaded = ready(pid, "custom Tab");
    dump("custom Tab: loaded", loaded);
    expect(readyLine(loaded)).toMatch(/^ready errors=0 tab=(?!Shellwise)\S+ stab=ShellwisePrevious$/);

    drive(pid, [{ type: "text", value: "zz" }, { type: "key", value: "tab" }]);
    const custom = waitForScreen(pid, "custom Tab", (rows) => promptText(rows) === "PS> zz<MY-TAB>");
    dump("custom Tab: zz + Tab", custom);

    drive(pid, [escape, escape, { type: "text", value: "git st" }]);
    const listed = waitForScreen(pid, "list", (rows) => promptText(rows) === "PS> git st" && listItems(rows).length > 0);
    const items = listItems(listed).map((i) => i.text);
    drive(pid, [{ type: "key", value: "shift-tab" }]);
    waitForScreen(pid, "Shift+Tab", (rows) => promptText(rows) === `PS> ${items[items.length - 1]}`);
  }, TEST_TIMEOUT_MS);

  test("in a window too small for the list: no warning, the view and Tab left alone", () => {
    const pid = start([
      "[Console]::SetWindowSize(40, 30)",
      INIT,
      `"ready errors=$($Error.Count) view=$((Get-PSReadLineOption).PredictionViewStyle) tab=$((Get-PSReadLineKeyHandler -Chord Tab).Function)"`,
    ]);
    const rows = ready(pid, "small window");
    dump("small window: loaded", rows);
    expect(rows.filter((r) => r !== "")).toEqual(["ready errors=0 view=InlineView tab=TabCompleteNext", "PS>"]);
  }, TEST_TIMEOUT_MS);
});
