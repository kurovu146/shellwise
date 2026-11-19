import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generatePowerShellScript } from "../../src/cli/init";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
// No such program exists, so a script loaded by these tests can never start a
// real shellwise (its daemon start and recording are no-ops without BinPath).
const NO_BIN = "sw-no-such-binary-for-tests";

const script = generatePowerShellScript("shellwise", { socketPath: "C:\\T\\it's.sock", dataDir: "C:\\D" });

let dir: string;
let env: Record<string, string>;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sw-ps-script-"));
  env = {
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    // Nothing listens here, so the CLI falls back to the isolated DB.
    SHELLWISE_DAEMON_SOCKET: join(dir, "no-daemon.sock"),
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const p = Bun.spawnSync([process.execPath, ENTRY, ...args], { env: { ...process.env, ...env, ...extraEnv } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("generatePowerShellScript", () => {
  test("carries the integration marker line", () => {
    expect(script).toContain("# --- shellwise shell integration ---");
  });

  test("embeds the socket path as a single-quoted literal with the apostrophe doubled", () => {
    expect(script).toContain("'C:\\T\\it''s.sock'");
  });

  test("binds Ctrl+R and wraps the prompt", () => {
    expect(script).toContain("Set-PSReadLineKeyHandler -Chord 'Ctrl+r'");
    expect(script).toContain("Set-Item -Path function:global:prompt");
  });

  test("is pure ASCII, whatever the paths contain", () => {
    // PowerShell decodes a native command's stdout with the console code page,
    // so any non-ASCII byte in `init powershell | Invoke-Expression` is mangled.
    const s = generatePowerShellScript("shellwise", { socketPath: "C:\\Users\\Tuấn\\a.sock", dataDir: "C:\\D\\việt" });
    expect(s).toMatch(/^[\x00-\x7f]*$/);
  });
});

describe("init powershell", () => {
  test.each(["powershell", "pwsh"])("`init %s` prints the script", (shell) => {
    const r = cli(["init", shell]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# --- shellwise shell integration ---");
    // The isolated endpoint, not the default one.
    expect(r.out).toContain(`'${env.SHELLWISE_DAEMON_SOCKET.replace(/'/g, "''")}'`);
  });

  test("rejects --remote with a message naming zsh", () => {
    const r = cli(["init", "powershell", "--remote"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("zsh");
    expect(r.out).toBe("");
  });

  test("lists powershell among the supported shells", () => {
    const r = cli(["init", "tcsh"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Supported: zsh, bash, fish, powershell");
  });
});

describe("add --from-env", () => {
  // Quotes, `$`, backtick, `%`, `&`, `|` and non-ASCII: everything a Windows
  // command line would mangle on the way to the CLI.
  const tricky = `echo "a b" 'c' $x \`t %PATH% & | tiếng việt`;

  test("records the command and its fields from SW_ADD_* exactly as given", () => {
    const r = cli(["add", "--from-env"], {
      SW_ADD_COMMAND: tricky,
      SW_ADD_CWD: "C:\\work",
      SW_ADD_EXIT_CODE: "0",
      SW_ADD_DURATION: "12",
      SW_ADD_SESSION: "s-1",
      SW_ADD_SHELL: "powershell",
    });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(cli(["suggest", "--query", 'echo "a b']).out.split("\n")).toContain(tricky);
    // Every field landed in its own column, read straight from the DB.
    const db = new Database(join(dir, "data", "shellwise", "history.db"), { readonly: true });
    try {
      const row = db
        .query("SELECT cwd, exit_code, duration_ms, session_id, shell FROM commands WHERE command = ?")
        .get(tricky);
      expect(row).toEqual({ cwd: "C:\\work", exit_code: 0, duration_ms: 12, session_id: "s-1", shell: "powershell" });
    } finally {
      db.close();
    }
  });

  test("skips a failed command", () => {
    const r = cli(["add", "--from-env"], { SW_ADD_COMMAND: "echo failed-one", SW_ADD_EXIT_CODE: "3" });
    expect(r.code).toBe(0);
    expect(cli(["suggest", "--query", "echo failed"]).out).not.toContain("echo failed-one");
  });

  test("exits 1 when SW_ADD_COMMAND is missing", () => {
    const r = cli(["add", "--from-env"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Usage");
  });
});

// Every shell available here must parse the script and load it without error:
// pwsh 7 and, on Windows, PowerShell 5.1, whose parser and .NET are older.
const SHELLS = ["pwsh", "powershell.exe"].filter((s) => Bun.which(s) !== null);
// A cold PowerShell start alone can pass the default 5 s on a loaded machine.
const SHELL_TIMEOUT_MS = 20_000;

describe.each(SHELLS.length > 0 ? SHELLS : ["(none)"])("the script in %s", (shell) => {
  const run = (command: string) => {
    const p = Bun.spawnSync([shell, "-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, ...env },
    });
    return { out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };
  const scriptFile = (name: string, content: string) => {
    const f = join(dir, `${shell}-${name}.ps1`);
    writeFileSync(f, content);
    return f;
  };

  test.skipIf(SHELLS.length === 0)("parses with no errors", () => {
    const f = scriptFile("parse", script);
    const r = run(
      `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput((Get-Content -Raw '${f}'), [ref]$null, [ref]$e); $e.Count`
    );
    expect(r.err).toBe("");
    expect(r.out).toBe("0");
  }, SHELL_TIMEOUT_MS);

  // Loading the script again (a reloaded profile, the init line run by hand)
  // must never make the prompt call itself, whatever wrapped it in between.
  // A recursing prompt only dies of "call depth overflow" after 30-60 s, so
  // the test timeout catches it. Strict mode, with no native command run yet,
  // also leaves $LASTEXITCODE unset: reading it would throw.
  test.skipIf(SHELLS.length === 0).each([
    ["twice in a row", "", "orig> "],
    // Python's venv Activate.ps1 and zoxide: keep the current prompt, call it.
    ["after a tool wrapped the prompt", "$global:old = $function:prompt; function global:prompt { 'venv ' + (& $global:old) }", "venv orig> "],
    ["after the prompt was replaced", "function global:prompt { 'user> ' }", "user> "],
  ])("loads again %s: one prompt, recorded once, same session", (_, between, expected) => {
    const f = scriptFile("reload", generatePowerShellScript(NO_BIN, { socketPath: join(dir, "x.sock"), dataDir: dir }));
    const load = `Invoke-Expression (Get-Content -Raw '${f}')`;
    const r = run(
      [
        "Set-StrictMode -Version Latest",
        "function prompt { 'orig> ' }",
        load,
        "$s1 = $global:__sw.Session",
        between,
        load,
        // What the prompt would record, without a binary to record with.
        "$global:rec = @(); function global:__sw_spawn($a, $e) { if ($a[0] -eq 'add') { $global:rec += $e.SW_ADD_COMMAND } }",
        "$now = Get-Date; $done = [System.Management.Automation.Runspaces.PipelineState]::Completed",
        "Add-History -InputObject ([pscustomobject]@{ CommandLine = 'echo one'; ExecutionStatus = $done; StartExecutionTime = $now; EndExecutionTime = $now })",
        // A second prompt with no new command records nothing more.
        "'out=' + (prompt)",
        "'out=' + (prompt)",
        "'rec=' + ($global:rec -join '|')",
        "'same-session=' + ($s1 -eq $global:__sw.Session)",
        "'errors=' + $Error.Count",
      ].join("; ")
    );
    expect(r.err).toBe("");
    expect(r.out.split(/\r?\n/)).toEqual([
      `out=${expected}`,
      `out=${expected}`,
      "rec=echo one",
      "same-session=True",
      "errors=0",
    ]);
  }, SHELL_TIMEOUT_MS);

  test.skipIf(SHELLS.length === 0)("does not record a multi-line command", () => {
    // The daemon's protocol is one line per request. (Through a live daemon the
    // broken-up request happens to store nothing; the DB fallback would.)
    const f = scriptFile("multi", generatePowerShellScript(NO_BIN, { socketPath: join(dir, "x.sock"), dataDir: dir }));
    const add = (line: string) =>
      `Add-History -InputObject ([pscustomobject]@{ CommandLine = ${line}; ExecutionStatus = $done; StartExecutionTime = $now; EndExecutionTime = $now })`;
    const r = run(
      [
        "function prompt { 'orig> ' }",
        `Invoke-Expression (Get-Content -Raw '${f}')`,
        "$global:rec = @(); function global:__sw_spawn($a, $e) { if ($a[0] -eq 'add') { $global:rec += $e.SW_ADD_COMMAND } }",
        "$now = Get-Date; $done = [System.Management.Automation.Runspaces.PipelineState]::Completed",
        add('"if (1) {`necho multi-1 }"'),
        "$null = prompt",
        add("'echo two'"),
        "$null = prompt",
        "'rec=' + ($global:rec -join '|')",
      ].join("; ")
    );
    expect(r.err).toBe("");
    expect(r.out).toBe("rec=echo two");
  }, SHELL_TIMEOUT_MS);

  test.skipIf(SHELLS.length === 0)("keeps a non-ASCII path intact", () => {
    const sock = "C:\\Users\\Tuấn\\it's.sock";
    const f = scriptFile("ascii", generatePowerShellScript(NO_BIN, { socketPath: sock, dataDir: dir }));
    // Compare code points: the console code page would mangle printed text.
    const r = run(`Invoke-Expression (Get-Content -Raw '${f}'); ($global:__sw.Socket.ToCharArray() | ForEach-Object { [int]$_ }) -join ','`);
    expect(r.err).toBe("");
    expect(r.out).toBe([...sock].map((c) => c.charCodeAt(0)).join(","));
  }, SHELL_TIMEOUT_MS);
});
