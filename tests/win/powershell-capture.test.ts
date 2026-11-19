import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { drive, killTree, removeDir, startHiddenConsole, waitForExit, type Step } from "./console-harness";

const REPO = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO, "src", "index.ts");
// A shell plus PSReadLine starting cold, then several commands that each spawn bun.
const TEST_TIMEOUT_MS = 60_000;
const SHELLS = ["pwsh", "powershell.exe"].filter((s) => Bun.which(s) !== null);

// Quotes, `$`, backtick, `%`, `&`, `|` and non-ASCII: what a Windows command
// line or a code-page decode would mangle on the way into history and back.
const TRICKY = "echo \"a b\" 'c' '$x' \"`$y\" '%PATH%' 'p&q|r' tiếng việt";
// The TUI's status bar: on screen exactly while the search is open.
const TUI_MARK = "Esc:cancel";

const enter: Step = { type: "key", value: "enter" };
const typeLine = (value: string): Step[] => [{ type: "text", value }, enter];
/** Index of the last non-blank row: where the prompt line sits. */
const lastRow = (rows: string[]) => rows.findLastIndex((r) => r !== "");
const promptLine = (rows: string[]) => rows[lastRow(rows)] ?? "";
const same = (a: string[], b: string[]) => a.length === b.length && a.every((r, i) => r === b[i]);
// SW_E2E_DUMP=1 prints the screens the assertions look at; quiet otherwise.
const dump = (title: string, rows: string[]) => {
  if (process.env.SW_E2E_DUMP) console.log(`--- ${title}\n${rows.join("\n").trimEnd()}`);
};

describe.skipIf(process.platform !== "win32")("PowerShell integration in a real console", () => {
  for (const shell of SHELLS) {
    describe(shell, () => {
      let dir: string;
      let env: Record<string, string>;
      let pid: number | null = null;

      beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "sw-ps-e2e-"));
        const bin = join(dir, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "shellwise.cmd"), `@"${process.execPath}" "${ENTRY}" %*\r\n`);
        // Started from PowerShell the variable is "Path": a second "PATH" key
        // would lose to it in the child's environment.
        const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
        env = {
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
        const profile = [
          // The driver reads 30 rows; powershell.exe's own console default is 50.
          `[Console]::SetWindowSize(120, 30)`,
          // Keep PSReadLine off the user's real history file, and its inline
          // predictions (2.1+) off the screen: they would echo our commands back.
          `Set-PSReadLineOption -HistorySavePath '${join(dir, "psreadline-history.txt")}'`,
          `if ((Get-Module PSReadLine).Version -ge [version]'2.1') { Set-PSReadLineOption -PredictionSource None }`,
          `function prompt { "[st=$?/$LASTEXITCODE] PS> " }`,
          `shellwise init powershell | Out-String | Invoke-Expression`,
          `"ready psreadline=$((Get-Module PSReadLine).Version) ps=$($PSVersionTable.PSVersion)"`,
        ];
        writeFileSync(join(dir, "profile.ps1"), profile.join("\r\n") + "\r\n");
        pid = startHiddenConsole(
          shell,
          ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", join(dir, "profile.ps1")],
          env
        );
      });

      afterAll(() => {
        if (pid !== null) killTree(pid);
        pid = null;
        cli(["daemon", "stop"]);
        removeDir(dir);
      });

      function cli(args: string[]): string {
        const p = Bun.spawnSync([process.execPath, ENTRY, ...args], { env: { ...process.env, ...env } });
        return p.stdout.toString();
      }

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

      const tuiClosedWith = (line: string) => (rows: string[]) =>
        !rows.some((r) => r.includes(TUI_MARK)) && promptLine(rows).endsWith(line);

      test("loads cleanly and records a command run at the prompt", () => {
        const [loaded] = drive(pid!, [
          { type: "waitFor", text: "] PS>", timeoutMs: 20_000 },
          { type: "screen", label: "loaded" },
          ...typeLine("echo capture-me-1"),
        ]);
        dump(`${shell}: loaded`, loaded.lines);
        // No error text anywhere before the first prompt.
        expect(loaded.lines).toEqual([expect.stringMatching(/^ready psreadline=/), "[st=True/0] PS>"]);
        if (shell === "powershell.exe") expect(loaded.lines[0]).toContain(" ps=5.1.");
        expectRecorded("echo capture", "echo capture-me-1");
      }, TEST_TIMEOUT_MS);

      test("hands $? and $LASTEXITCODE on to the wrapped prompt and skips failed commands", () => {
        const [failed, succeeded] = drive(pid!, [
          ...typeLine("cmd /c exit 3"),
          { type: "waitFor", text: "[st=False/3] PS>" },
          { type: "screen", label: "failed" },
          // A cmdlet that succeeds: $? is true again, $LASTEXITCODE still 3.
          ...typeLine("echo after-fail"),
          { type: "waitFor", text: "[st=True/3] PS>" },
          { type: "screen", label: "succeeded" },
        ]);
        dump(`${shell}: after a failure, then a success`, succeeded.lines);
        expect(promptLine(failed.rows)).toBe("[st=False/3] PS>");
        expect(promptLine(succeeded.rows)).toBe("[st=True/3] PS>");

        // The failed command's recorder was spawned before this one's.
        expectRecorded("echo after", "echo after-fail");
        expect(suggest("cmd /c exit")).not.toContain("cmd /c exit 3");
      }, TEST_TIMEOUT_MS);

      test("records quotes, $, backtick, %, &, | and non-ASCII exactly as typed", () => {
        drive(pid!, [...typeLine(`echo "a b" 'c'`), ...typeLine(TRICKY)]);
        expectRecorded('echo "a', `echo "a b" 'c'`);
        expectRecorded("tiếng việt", TRICKY);
      }, TEST_TIMEOUT_MS);

      test("Ctrl+R searches for the line, puts the choice on it and redraws the prompt as it was", () => {
        // Start from a failure: the redrawn prompt must still show it, not the
        // search's own exit or the key handler's $?.
        drive(pid!, [...typeLine("cmd /c exit 4"), { type: "waitFor", text: "[st=False/4] PS>" }]);
        drive(pid!, [{ type: "text", value: "echo cap" }]);
        const before = waitForScreen("typed", (rows) => promptLine(rows) === "[st=False/4] PS> echo cap");
        const p0 = lastRow(before);

        // Escape: the line stays as it was.
        drive(pid!, [{ type: "key", value: "ctrl-r" }, { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 }]);
        drive(pid!, [{ type: "key", value: "escape" }]);
        const cancelled = waitForScreen("cancelled", tuiClosedWith("PS> echo cap"));

        const [tuiScreen] = drive(pid!, [
          { type: "key", value: "ctrl-r" },
          { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 },
          { type: "screen", label: "tui" },
          enter,
        ]);
        const tui = tuiScreen.rows;
        const after = waitForScreen("after", tuiClosedWith("PS> echo capture-me-1"));

        // As in zsh and fish, the search box takes over the prompt's row, with
        // the line as its query, and lists the command. The rows above survive
        // (the window may have scrolled to make room for the frame).
        const row = tui.indexOf("> echo cap");
        expect(row).toBeGreaterThan(0);
        expect(tui.slice(row + 1).some((r) => r.includes("echo capture-me-1"))).toBe(true);
        expect(tui.slice(0, row)).toEqual(before.slice(p0 - row, p0));

        // Afterwards the prompt is back on that row with the same status, the
        // rows above are intact and no TUI row is left below.
        for (const rows of [cancelled, after]) {
          expect(lastRow(rows)).toBe(row);
          expect(rows.slice(0, row)).toEqual(tui.slice(0, row));
        }
        expect(cancelled[row]).toBe("[st=False/4] PS> echo cap");
        expect(after[row]).toBe("[st=False/4] PS> echo capture-me-1");

        dump(`${shell}: before Ctrl+R`, before);
        dump(`${shell}: Ctrl+R open`, tui);
        dump(`${shell}: after Escape`, cancelled);
        dump(`${shell}: after Enter`, after);
      }, TEST_TIMEOUT_MS);

      test("Ctrl+R brings back quotes, $, %, &, | and non-ASCII intact", () => {
        // Escape clears the line the previous test left.
        drive(pid!, [
          { type: "key", value: "escape" },
          { type: "text", value: "việt" },
          { type: "key", value: "ctrl-r" },
          { type: "waitFor", text: TUI_MARK, timeoutMs: 10_000 },
          enter,
        ]);
        const after = waitForScreen("after", tuiClosedWith(`PS> ${TRICKY}`));
        dump(`${shell}: after Enter on the non-ASCII command`, after);
        drive(pid!, [{ type: "key", value: "escape" }]);
      }, TEST_TIMEOUT_MS);

      test("the daemon started at load outlives the shell and still answers", () => {
        // Escape first: a failed test before this one may have left text on the line.
        drive(pid!, [{ type: "key", value: "escape" }, ...typeLine("exit")]);
        expect(waitForExit(pid!, 10_000)).toBe(true);
        pid = null;
        const status = cli(["daemon", "status"]);
        dump(`${shell}: daemon status after the shell exited`, [status]);
        expect(status).toMatch(/^Daemon running \(pid: \d+\)/);
      }, TEST_TIMEOUT_MS);
    });
  }
});
