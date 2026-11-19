import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  drive,
  killTree,
  removeDir,
  startHiddenConsole,
  startPseudoConsole,
  waitForExit,
  type Step,
} from "./console-harness";

const REPO = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO, "src", "index.ts");
// A shell plus PSReadLine starting cold, then several commands that each spawn bun.
const TEST_TIMEOUT_MS = 60_000;
const SHELLS = ["pwsh", "powershell.exe"].filter((s) => Bun.which(s) !== null);
// conhost as Start-Process opens it (a tall scrollback buffer), the same with
// no scrollback, and a pseudo console (Windows Terminal, VS Code), which also
// has none: there a frame that needs room scrolls the buffer itself.
const TERMINALS = ["conhost", "conhost, no scrollback", "pseudo console"] as const;
type Terminal = (typeof TERMINALS)[number];

// Quotes, `$`, backtick, `%`, `&`, `|` and non-ASCII: what a Windows command
// line or a code-page decode would mangle on the way into history and back.
const TRICKY = "echo \"a b\" 'c' '$x' \"`$y\" '%PATH%' 'p&q|r' tiếng việt";
// The TUI's status bar and its time column: on screen only while it is open.
const TUI_MARK = "Esc:cancel";
const TUI_ROW_MARK = "just now";
const PROMPT = /^\[st=(True|False)\/\d*\] PS>/;

const enter: Step = { type: "key", value: "enter" };
const typeLine = (value: string): Step[] => [{ type: "text", value }, enter];
/** Index of the prompt line: PSReadLine's prediction list may sit below it. */
const promptIndex = (rows: string[]) => rows.findLastIndex((r) => PROMPT.test(r));
const promptText = (rows: string[]) => rows[promptIndex(rows)] ?? "";
const same = (a: string[], b: string[]) => a.length === b.length && a.every((r, i) => r === b[i]);
const tuiGone = (rows: string[]) => !rows.some((r) => r.includes(TUI_MARK) || r.includes(TUI_ROW_MARK) || /^─+$/.test(r));
// SW_E2E_DUMP=1 prints the screens the assertions look at; quiet otherwise.
const dump = (title: string, rows: string[]) => {
  if (process.env.SW_E2E_DUMP) console.log(`--- ${title}\n${rows.join("\n").trimEnd()}`);
};

/**
 * A temp dir with a `shellwise.cmd` shim first on PATH, and the env that
 * isolates everything shellwise touches (history DB, daemon endpoint) in it.
 */
function sandbox(shell: string): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "sw-ps-e2e-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "shellwise.cmd"), `@"${process.execPath}" "${ENTRY}" %*\r\n`);
  // Started from PowerShell the variable is "Path": a second "PATH" key
  // would lose to it in the child's environment.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const env: Record<string, string> = {
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    SHELLWISE_DAEMON_SOCKET: join(dir, "daemon.sock"),
    [pathKey]: `${bin};${process.env[pathKey]}`,
  };
  if (shell === "powershell.exe") {
    // Launched from pwsh, the inherited PSModulePath lists pwsh 7's own
    // module dirs, and 5.1 would load pwsh's newer PSReadLine from there.
    // Keep what a 5.1 started from the Start menu sees.
    const own = (process.env.PSModulePath ?? "").split(";").filter((p) => /WindowsPowerShell/i.test(p));
    env.PSModulePath = own.join(";");
  }
  return { dir, env };
}

function cliIn(env: Record<string, string>, args: string[]): string {
  const p = Bun.spawnSync([process.execPath, ENTRY, ...args], { env: { ...process.env, ...env } });
  return p.stdout.toString();
}

interface Row {
  command: string;
  cwd: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  session_id: string | null;
  shell: string | null;
}

/** Every row of the sandbox's history DB, read directly. */
function dbRows(env: Record<string, string>): Row[] {
  const db = new Database(join(env.XDG_DATA_HOME, "shellwise", "history.db"), { readonly: true });
  try {
    return db.query<Row, []>("SELECT command, cwd, exit_code, duration_ms, session_id, shell FROM commands").all();
  } finally {
    db.close();
  }
}

describe.skipIf(process.platform !== "win32")("loading the script in a shell whose output is captured", () => {
  for (const shell of SHELLS) {
    test(`${shell} returns its output at once and leaves the daemon running`, async () => {
      const { dir, env } = sandbox(shell);
      const profile = join(dir, "profile.ps1");
      writeFileSync(profile, "shellwise init powershell | Out-String | Invoke-Expression\r\n");
      try {
        expect(cliIn(env, ["daemon", "status"])).toContain("Daemon not running");
        const p = Bun.spawn([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `. '${profile}'; 'done'`], {
          env: { ...process.env, ...env },
          stdout: "pipe",
          stderr: "pipe",
        });
        // Reading to EOF is what a caller capturing the output does: any
        // process we started that kept the pipe would hold this open.
        const output = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), 15_000));
        const result = await Promise.race([output, timeout]);
        expect(result).not.toBeNull();
        const [out, err] = result!;
        expect(err).toBe("");
        expect(out.trim()).toBe("done");

        // The load still started the daemon, and it keeps running.
        const deadline = Date.now() + 10_000;
        while (!cliIn(env, ["daemon", "status"]).includes("Daemon running") && Date.now() < deadline) Bun.sleepSync(100);
        expect(cliIn(env, ["daemon", "status"])).toContain("Daemon running");
      } finally {
        cliIn(env, ["daemon", "stop"]);
        removeDir(dir);
      }
    }, TEST_TIMEOUT_MS);
  }
});

describe.skipIf(process.platform !== "win32")("PowerShell integration in a real console", () => {
  for (const shell of SHELLS) {
    for (const terminal of TERMINALS) {
      describeShell(shell, terminal);
    }
  }
});

function describeShell(shell: string, terminal: Terminal): void {
  // pwsh runs with the prediction list on (PSReadLine 2.2+), as many profiles
  // set it; Windows PowerShell's PSReadLine 2.0 has no predictions at all.
  const predictions = shell === "pwsh";

  describe(`${shell} in ${terminal}`, () => {
    let dir: string;
    let env: Record<string, string>;
    let work: string;
    let pid: number | null = null;
    let hostPid: number | null = null;

    beforeAll(() => {
      ({ dir, env } = sandbox(shell));
      work = join(dir, "work");
      mkdirSync(work);
      const profile = [
        // The driver reads 30 rows; powershell.exe's own console default is 50.
        // A pseudo console already has the size it was opened with.
        ...(terminal === "pseudo console" ? [] : [`[Console]::SetWindowSize(120, 30)`]),
        ...(terminal === "conhost, no scrollback" ? [`[Console]::SetBufferSize(120, 30)`] : []),
        // Keep PSReadLine off the user's real history file.
        `Set-PSReadLineOption -HistorySavePath '${join(dir, "psreadline-history.txt")}'`,
        predictions
          ? `Set-PSReadLineOption -PredictionSource History -PredictionViewStyle ListView`
          : `if ((Get-Module PSReadLine).Version -ge [version]'2.1') { Set-PSReadLineOption -PredictionSource None }`,
        `Set-Location -LiteralPath '${work}'`,
        `function prompt { "[st=$?/$LASTEXITCODE] PS> " }`,
        `shellwise init powershell | Out-String | Invoke-Expression`,
        `"ready psreadline=$((Get-Module PSReadLine).Version) ps=$($PSVersionTable.PSVersion)"`,
      ];
      writeFileSync(join(dir, "profile.ps1"), profile.join("\r\n") + "\r\n");
      const args = ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", join(dir, "profile.ps1")];
      if (terminal === "pseudo console") {
        ({ pid, hostPid } = startPseudoConsole(shell, args, env));
      } else {
        pid = hostPid = startHiddenConsole(shell, args, env);
      }
    });

    afterAll(() => {
      if (hostPid !== null) killTree(hostPid);
      pid = hostPid = null;
      cli(["daemon", "stop"]);
      removeDir(dir);
    });

    const cli = (args: string[]) => cliIn(env, args);
    const suggest = (query: string) => cli(["suggest", "--query", query, "--limit", "20"]).split("\n");

    /** Poll history until `command` is in it (recording is fire-and-forget). */
    function expectRecorded(query: string, command: string): void {
      const deadline = Date.now() + 10_000;
      while (!suggest(query).includes(command)) {
        if (Date.now() > deadline) throw new Error(`never recorded: ${command}\nfound: ${suggest(query).join(" | ")}`);
        Bun.sleepSync(100);
      }
    }

    /**
     * Poll the window until `done` holds on two reads in a row. The driver's
     * waitFor cannot do this: older rows still show the texts we wait for.
     */
    function waitForScreen(what: string, done: (rows: string[]) => boolean): string[] {
      const deadline = Date.now() + 10_000;
      let prev: string[] = [];
      while (true) {
        const rows = drive(pid!, [{ type: "screen", label: what }])[0].rows;
        if (done(rows) && same(prev, rows)) return rows;
        prev = rows;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last screen:\n${rows.join("\n")}`);
        Bun.sleepSync(50);
      }
    }

    const closedWith = (line: string) => (rows: string[]) => tuiGone(rows) && promptText(rows) === line;

    /** Below the prompt: nothing at all, or only PSReadLine's own prediction list. */
    function expectNothingOfTheTuiBelow(rows: string[]): void {
      const below = rows.slice(promptIndex(rows) + 1);
      if (predictions) expect(tuiGone(below)).toBe(true);
      else expect(below.every((r) => r === "")).toBe(true);
    }

    test("loads cleanly and records a command with its cwd, session, shell and duration", () => {
      const [loaded] = drive(pid!, [
        { type: "waitFor", text: "] PS>", timeoutMs: 20_000 },
        { type: "screen", label: "loaded" },
        ...typeLine("echo capture-me-1"),
        ...typeLine("Start-Sleep -Milliseconds 300"),
      ]);
      dump(`${shell} in ${terminal}: loaded`, loaded.lines);
      // No error text anywhere before the first prompt.
      expect(loaded.lines).toEqual([expect.stringMatching(/^ready psreadline=/), "[st=True/0] PS>"]);
      if (shell === "powershell.exe") expect(loaded.lines[0]).toContain(" ps=5.1.");
      expectRecorded("echo capture", "echo capture-me-1");
      expectRecorded("Start-Sleep", "Start-Sleep -Milliseconds 300");

      const rows = dbRows(env);
      const echo = rows.find((r) => r.command === "echo capture-me-1")!;
      const sleep = rows.find((r) => r.command === "Start-Sleep -Milliseconds 300")!;
      for (const r of [echo, sleep]) {
        expect(r.cwd).toBe(work);
        expect(r.shell).toBe("powershell");
        expect(r.exit_code).toBe(0);
        expect(r.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
      expect(sleep.session_id).toBe(echo.session_id);
      expect(sleep.duration_ms).toBeGreaterThanOrEqual(290);
      expect(sleep.duration_ms).toBeLessThan(10_000);
    }, TEST_TIMEOUT_MS);

    test("hands $? and $LASTEXITCODE on to the wrapped prompt, skips failed commands, stores each command once", () => {
      const [failed, succeeded] = drive(pid!, [
        ...typeLine("cmd /c exit 3"),
        { type: "waitFor", text: "[st=False/3] PS>" },
        { type: "screen", label: "failed" },
        // A cmdlet that succeeds: $? is true again, $LASTEXITCODE still 3.
        ...typeLine("echo after-fail"),
        { type: "waitFor", text: "[st=True/3] PS>" },
        { type: "screen", label: "succeeded" },
        // Empty lines redraw the prompt with no new history entry: the last
        // command must not be stored again.
        enter,
        enter,
        ...typeLine("echo dedupe-sentinel"),
      ]);
      dump(`${shell} in ${terminal}: after a failure, then a success`, succeeded.lines);
      expect(promptText(failed.rows)).toBe("[st=False/3] PS>");
      expect(promptText(succeeded.rows)).toBe("[st=True/3] PS>");

      // Each recorder was spawned before the next command's.
      expectRecorded("echo dedupe", "echo dedupe-sentinel");
      expect(suggest("cmd /c exit")).not.toContain("cmd /c exit 3");
      expect(dbRows(env).filter((r) => r.command === "echo after-fail")).toHaveLength(1);
    }, TEST_TIMEOUT_MS);

    test("records quotes, $, backtick, %, &, | and non-ASCII exactly as typed, and skips multi-line commands", () => {
      drive(pid!, [
        ...typeLine(`echo "a b" 'c'`),
        ...typeLine(TRICKY),
        // An open brace makes PSReadLine continue on a second line.
        ...typeLine("if ($true) {"),
        ...typeLine("echo multi-1 }"),
        ...typeLine("echo after-multi"),
      ]);
      expectRecorded('echo "a', `echo "a b" 'c'`);
      expectRecorded("tiếng việt", TRICKY);
      expectRecorded("echo after-multi", "echo after-multi");
      expect(dbRows(env).filter((r) => r.command.includes("multi-1") || r.command.includes("if ($true)"))).toEqual([]);
    }, TEST_TIMEOUT_MS);

    test("Ctrl+R replaces the line with the choice and redraws the prompt as it was", () => {
      // Start from a failure: the redrawn prompt must still show it, not the
      // search's own exit or the key handler's $?.
      drive(pid!, [...typeLine("cmd /c exit 4"), { type: "waitFor", text: "[st=False/4] PS>" }]);
      drive(pid!, [{ type: "text", value: "echo cap" }]);
      const before = waitForScreen("typed", (rows) => promptText(rows) === "[st=False/4] PS> echo cap");
      const p0 = promptIndex(before);

      // Escape: the line stays as it was.
      drive(pid!, [{ type: "key", value: "ctrl-r" }, { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 }]);
      drive(pid!, [{ type: "key", value: "escape" }]);
      const cancelled = waitForScreen("cancelled", closedWith("[st=False/4] PS> echo cap"));

      const [tuiScreen] = drive(pid!, [
        { type: "key", value: "ctrl-r" },
        { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 },
        { type: "screen", label: "tui" },
        enter,
      ]);
      const tui = tuiScreen.rows;
      // The choice replaces what was typed, never lands after it.
      const after = waitForScreen("after", closedWith("[st=False/4] PS> echo capture-me-1"));

      // As in zsh and fish, the search box takes over the prompt's row, with
      // the line as its query, and lists the command. The rows above survive
      // (they may have scrolled up to make room for the frame).
      const row = tui.indexOf("> echo cap");
      expect(row).toBeGreaterThan(0);
      expect(tui.slice(row + 1).some((r) => r.includes("echo capture-me-1") && r.includes(TUI_ROW_MARK))).toBe(true);
      expect(tui.slice(0, row)).toEqual(before.slice(p0 - row, p0));

      // Afterwards the prompt is back on that row with the same status, the
      // rows above are intact and nothing of the TUI is left below.
      for (const rows of [cancelled, after]) {
        expect(promptIndex(rows)).toBe(row);
        expect(rows.slice(0, row)).toEqual(tui.slice(0, row));
        expectNothingOfTheTuiBelow(rows);
      }

      dump(`${shell} in ${terminal}: before Ctrl+R`, before);
      dump(`${shell} in ${terminal}: Ctrl+R open`, tui);
      dump(`${shell} in ${terminal}: after Escape`, cancelled);
      dump(`${shell} in ${terminal}: after Enter`, after);
    }, TEST_TIMEOUT_MS);

    test("Ctrl+R brings back quotes, $, %, &, | and non-ASCII intact", () => {
      // Run the line the previous test left, then search for the command.
      drive(pid!, [enter]);
      waitForScreen("ran", (rows) => promptText(rows) === "[st=True/4] PS>");
      drive(pid!, [
        { type: "text", value: "việt" },
        { type: "key", value: "ctrl-r" },
        { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 },
        enter,
      ]);
      const after = waitForScreen("after", closedWith(`[st=True/4] PS> ${TRICKY}`));
      dump(`${shell} in ${terminal}: after Enter on the non-ASCII command`, after);
    }, TEST_TIMEOUT_MS);

    test("Ctrl+R with the prompt at the bottom keeps the scrollback and the prompt in place", () => {
      // Run the line left by the previous test, then fill the window so the
      // frame has no room below the prompt and must scroll to open.
      drive(pid!, [enter, ...typeLine(`1..40 | ForEach-Object { "filler $_" }`)]);
      waitForScreen("filled", (rows) => rows.includes("filler 40") && promptText(rows) === "[st=True/4] PS>");
      drive(pid!, [{ type: "text", value: "echo cap" }]);
      const before = waitForScreen("typed", (rows) => promptText(rows) === "[st=True/4] PS> echo cap");
      // The 19-row frame does not fit under this row of a 30-row window.
      expect(promptIndex(before)).toBeGreaterThan(30 - 19);

      // Each screen: the prompt with the expected line, and right above it an
      // unbroken run of filler lines ending with the last one: no blank rows
      // where the frame was, nothing lost or duplicated.
      const expectScrollbackThenPrompt = (rows: string[], line: string) => {
        const p = promptIndex(rows);
        expect(rows[p]).toBe(line);
        const fillers = Array.from({ length: p }, (_, i) => `filler ${40 - p + 1 + i}`);
        expect(rows.slice(0, p)).toEqual(fillers);
        expectNothingOfTheTuiBelow(rows);
      };

      drive(pid!, [{ type: "key", value: "ctrl-r" }, { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 }]);
      drive(pid!, [{ type: "key", value: "escape" }]);
      const cancelled = waitForScreen("cancelled", closedWith("[st=True/4] PS> echo cap"));
      expectScrollbackThenPrompt(cancelled, "[st=True/4] PS> echo cap");

      drive(pid!, [
        { type: "key", value: "ctrl-r" },
        { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 },
        enter,
      ]);
      const after = waitForScreen("after", closedWith("[st=True/4] PS> echo capture-me-1"));
      expectScrollbackThenPrompt(after, "[st=True/4] PS> echo capture-me-1");

      dump(`${shell} in ${terminal}: prompt at the bottom, before Ctrl+R`, before);
      dump(`${shell} in ${terminal}: prompt at the bottom, after Escape`, cancelled);
      dump(`${shell} in ${terminal}: prompt at the bottom, after a second Ctrl+R + Enter`, after);
    }, TEST_TIMEOUT_MS);

    test("the daemon started at load outlives the shell and still answers", () => {
      // Escape first: a failed test before this one may have left text on the line.
      drive(pid!, [{ type: "key", value: "escape" }, { type: "key", value: "escape" }, ...typeLine("exit")]);
      expect(waitForExit(pid!, 10_000)).toBe(true);
      pid = null;
      // A pseudo console's host ends with its only client.
      if (hostPid !== null && waitForExit(hostPid, 5000)) hostPid = null;
      const status = cli(["daemon", "status"]);
      dump(`${shell} in ${terminal}: daemon status after the shell exited`, [status]);
      expect(status).toMatch(/^Daemon running \(pid: \d+\)/);
    }, TEST_TIMEOUT_MS);
  });
}
