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
const HAS_PWSH = Bun.which("pwsh") !== null;
const TUI_MARK = "Esc:cancel";
// The last one ends in a word Tab completion would still change: selecting it
// must not also complete it (the old Tab job runs only when no list moved).
const SEEDED = ["git status", "git stash pop", "git log --oneline", "git stage; Get-Uptim"];

// PSReadLine as it comes (HistoryAndPlugin, inline view), with predictions
// turned off, and as the repo owner's profile sets it, with a PSReadLine
// history that shares the list with ours. All bind Tab to MenuComplete first,
// which must keep working when no list is showing.
const CONFIGS: Record<string, { options: string[]; psreadlineHistory: boolean }> = {
  "PSReadLine's defaults": { options: [], psreadlineHistory: false },
  "predictions off": { options: ["Set-PSReadLineOption -PredictionSource None"], psreadlineHistory: false },
  "the owner's profile (HistoryAndPlugin, ListView) and a PSReadLine history": {
    options: ["Set-PSReadLineOption -PredictionSource HistoryAndPlugin -PredictionViewStyle ListView"],
    psreadlineHistory: true,
  },
};
// In PSReadLine's history only, so the owner's list has an item of its own.
const PSREADLINE_ONLY = "git stash list";

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

describe.skipIf(process.platform !== "win32" || !HAS_PWSH)("PowerShell suggestions while typing", () => {
  for (const [name, config] of Object.entries(CONFIGS)) describeConfig(name, config.options, config.psreadlineHistory);
});

function describeConfig(name: string, options: string[], owner: boolean): void {
  describe(`pwsh with ${name}`, () => {
    let dir: string;
    let env: Record<string, string>;
    let psDir: string;
    let pid: number | null = null;

    const cli = (args: string[]) =>
      Bun.spawnSync([process.execPath, ENTRY, ...args], { env: { ...process.env, ...env } }).stdout.toString();
    const suggest = (query: string) => cli(["suggest", "--query", query, "--limit", "20"]).split("\n");

    function expectRecorded(query: string, command: string): void {
      const deadline = Date.now() + 10_000;
      while (!suggest(query).includes(command)) {
        if (Date.now() > deadline) throw new Error(`never recorded: ${command}\nfound: ${suggest(query).join(" | ")}`);
        Bun.sleepSync(100);
      }
    }

    /** Poll the window until `done` holds on two reads in a row. */
    function waitForScreen(what: string, done: (rows: string[]) => boolean, shell = pid!): string[] {
      const deadline = Date.now() + 10_000;
      let prev: string[] = [];
      while (true) {
        const rows = drive(shell, [{ type: "screen", label: what }])[0].rows;
        if (done(rows) && same(prev, rows)) return rows;
        prev = rows;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last screen:\n${rows.join("\n")}`);
        Bun.sleepSync(50);
      }
    }

    /** Press `key`, then wait until the prompt line reads `line`. */
    const press = (key: "tab" | "shift-tab", line: string) => {
      drive(pid!, [{ type: "key", value: key }]);
      return waitForScreen(`${key} -> ${line}`, (rows) => promptText(rows) === line);
    };

    /** Type `text` on an empty line and wait for the list to settle. */
    const typeAndWaitForList = (text: string, withList: boolean) => {
      drive(pid!, [escape, escape, { type: "text", value: text }]);
      return waitForScreen(`typed ${text}`, (rows) => promptText(rows) === `PS> ${text}` && listItems(rows).length > 0 === withList);
    };

    function startShell(profileLines: string[]): number {
      const profile = join(dir, `profile-${Date.now()}.ps1`);
      writeFileSync(profile, profileLines.join("\r\n") + "\r\n");
      const args = ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", profile];
      return startHiddenConsole("pwsh", args, env);
    }

    const baseProfile = () => [
      "[Console]::SetWindowSize(120, 30)",
      // Keep PSReadLine off the user's real history file.
      `Set-PSReadLineOption -HistorySavePath '${join(dir, "psreadline-history.txt")}'`,
      ...options,
      "Set-PSReadLineKeyHandler -Chord Tab -Function MenuComplete",
      `function prompt { "PS> " }`,
      "shellwise init powershell | Out-String | Invoke-Expression",
    ];

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "sw-ps-suggest-"));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "shellwise.cmd"), `@"${process.execPath}" "${ENTRY}" %*\r\n`);
      writeFileSync(join(dir, "psreadline-history.txt"), owner ? `${PSREADLINE_ONLY}\r\n` : "");
      const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      // A data dir with a space and a non-ASCII letter: the DLL cache is there.
      const data = join(dir, "data ệ");
      env = {
        XDG_DATA_HOME: data,
        XDG_CONFIG_HOME: join(dir, "config"),
        SHELLWISE_DAEMON_SOCKET: join(dir, "daemon.sock"),
        [pathKey]: `${bin};${process.env[pathKey]}`,
      };
      psDir = join(data, "shellwise", "ps");
      for (const command of SEEDED) cli(["add", command]);
      cli(["daemon", "start"]);
      pid = startShell([
        ...baseProfile(),
        // No process can record from here on: only the socket can (restored below).
        "$global:swBin = $global:__sw.BinPath; $global:__sw.BinPath = $null",
        `"ready helper=$($global:__sw.HasHelper) source=$((Get-PSReadLineOption).PredictionSource) view=$((Get-PSReadLineOption).PredictionViewStyle) errors=$($Error.Count)"`,
      ]);
    });

    afterAll(() => {
      if (pid !== null) killTree(pid);
      pid = null;
      cli(["daemon", "stop"]);
      removeDir(dir);
    });

    test("loads cleanly with the helper, compiled into a DLL under the data dir", () => {
      const [loaded] = drive(pid!, [
        { type: "waitFor", text: "PS>", timeoutMs: 20_000 },
        { type: "screen", label: "loaded" },
      ]);
      dump(`${name}: loaded`, loaded.lines);
      // Predictions off become ours only; a source with history keeps it.
      const source = options.some((o) => o.includes("None")) ? "Plugin" : "HistoryAndPlugin";
      expect(loaded.lines).toEqual([`ready helper=True source=${source} view=ListView errors=0`, "PS>"]);
      expect(readdirSync(psDir)).toEqual([expect.stringMatching(new RegExp(`^shellwise-helper-${HELPER_HASH}-7\\.\\d+\\.dll$`))]);
    }, TEST_TIMEOUT_MS);

    test("lists the daemon's suggestions as you type, with PSReadLine's own history in the owner's setup", () => {
      const rows = typeAndWaitForList("git st", true);
      dump(`${name}: typed git st`, rows);
      const items = listItems(rows);
      expect(items).toContainEqual({ text: "git status", source: "shellwise" });
      expect(items).toContainEqual({ text: "git stash pop", source: "shellwise" });
      if (owner) expect(items).toContainEqual({ text: PSREADLINE_ONLY, source: "History" });
      else expect(items.every((i) => i.source === "shellwise")).toBe(true);
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
      const db = new Database(join(env.XDG_DATA_HOME, "shellwise", "history.db"), { readonly: true });
      try {
        const row = db.query("SELECT shell, exit_code, session_id FROM commands WHERE command = ?").get("echo predictor-roundtrip");
        expect(row).toEqual({ shell: "powershell", exit_code: 0, session_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      } finally {
        db.close();
      }
    }, TEST_TIMEOUT_MS);

    test("with the daemon gone: no suggestions of ours and no error on screen", () => {
      expect(cli(["daemon", "stop"])).toContain("Daemon stopped");
      const rows = typeAndWaitForList("git st", owner);
      dump(`${name}: git st with the daemon down`, rows);
      expect(listItems(rows).filter((i) => i.source === "shellwise")).toEqual([]);
      // (The ready line reports "errors=0" itself.)
      expect(rows.filter((r) => /exception|error/i.test(r) && !r.startsWith("ready "))).toEqual([]);
    }, TEST_TIMEOUT_MS);

    test("with the daemon gone, commands are still recorded and the daemon is started again, once", () => {
      drive(pid!, [
        escape,
        escape,
        // The shell started less than 10 s ago, which holds restarts back:
        // make it look older. Both commands then find no daemon.
        ...typeLine("$global:__sw.BinPath = $global:swBin; $global:__sw.DaemonStartAt = [datetime]::MinValue"),
        ...typeLine("echo fallback-roundtrip"),
      ]);
      expectRecorded("echo fallback", "echo fallback-roundtrip");
      const deadline = Date.now() + 10_000;
      while (!cli(["daemon", "status"]).includes("Daemon running") && Date.now() < deadline) Bun.sleepSync(100);
      expect(cli(["daemon", "status"])).toContain("Daemon running");

      // No second daemon was started alongside: stopped, the one daemon lets
      // go of the data dir (its cwd, the DB), and nothing else holds it.
      expect(cli(["daemon", "stop"])).toContain("Daemon stopped");
      const data = join(env.XDG_DATA_HOME, "shellwise");
      renameSync(data, `${data}-moved`);
      renameSync(`${data}-moved`, data);
      expect(cli(["daemon", "start"])).toContain("Daemon started");
    }, TEST_TIMEOUT_MS);

    test("Ctrl+R replaces the line while the list is showing", () => {
      typeAndWaitForList("git st", true);
      drive(pid!, [{ type: "key", value: "ctrl-r" }, { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 }, enter]);
      const after = waitForScreen("after Ctrl+R", (rows) => !rows.some((r) => r.includes(TUI_MARK)) && /^PS> git/.test(promptText(rows)));
      dump(`${name}: after Ctrl+R + Enter`, after);
      expect(["PS> git status", "PS> git stash pop"]).toContain(promptText(after));
    }, TEST_TIMEOUT_MS);

    test("loading the script again keeps the list, Tab's old job, and adds no error", () => {
      drive(pid!, [
        escape,
        escape,
        ...typeLine(`shellwise init powershell | Out-String | Invoke-Expression; "reloaded errors=$($Error.Count) tab=$($global:__sw.TabFallback)"`),
      ]);
      const reloaded = waitForScreen("reloaded", (rows) => rows.some((r) => r.startsWith("reloaded ")) && promptText(rows) === "PS>");
      expect(reloaded.filter((r) => r.startsWith("reloaded "))).toEqual(["reloaded errors=0 tab=MenuComplete"]);
      typeAndWaitForList("Get-ChildIt", false);
      press("tab", "PS> Get-ChildItem");
      const items = listItems(typeAndWaitForList("git st", true));
      expect(items).toContainEqual({ text: "git status", source: "shellwise" });
      press("tab", `PS> ${items[0].text}`);
    }, TEST_TIMEOUT_MS);

    test("a second shell loads the cached DLL and leaves no temp file", () => {
      drive(pid!, [escape, escape, ...typeLine("exit")]);
      expect(waitForExit(pid!, 10_000)).toBe(true);
      pid = null;
      const [dll] = readdirSync(psDir);
      const built = statSync(join(psDir, dll)).mtimeMs;
      // (Compared in the shell: the path is too long for a row, and not ASCII.)
      pid = startShell([
        ...baseProfile(),
        `"ready helper=$($global:__sw.HasHelper) cached=$([ShellwisePredictor].Assembly.Location -eq (Join-Path $global:__sw.DataDir 'ps\\${dll}')) errors=$($Error.Count)"`,
      ]);
      const rows = waitForScreen("second shell", (r) => promptText(r) === "PS>");
      dump(`${name}: second shell`, rows);
      expect(rows.filter((r) => r !== "")).toEqual(["ready helper=True cached=True errors=0", "PS>"]);
      expect(readdirSync(psDir)).toEqual([dll]);
      expect(statSync(join(psDir, dll)).mtimeMs).toBe(built);
    }, TEST_TIMEOUT_MS);
  });
}
