import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { generatePowerShellScript } from "../../src/cli/init";
import { HELPER_HASH, HELPER_SOURCE } from "../../src/cli/init/powershell-helper.cs";
import { removeDir } from "../win/console-harness";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const FAKE_DAEMON = join(import.meta.dir, "fake-daemon.ts");
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
// Retries: on Windows a shell that just exited can still hold the helper DLL.
afterAll(() => removeDir(dir));

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

  test("sets up suggestions only from pwsh 7.2 with PSReadLine 2.2.2", () => {
    expect(script).toContain("$PSVersionTable.PSVersion -ge [version]'7.2'");
    expect(script).toContain("-ge [version]'2.2.2'");
  });

  test("embeds the helper source and names its cached DLL by the source hash", () => {
    // (A boolean: on failure the whole script would be printed twice.)
    expect(script.includes(HELPER_SOURCE)).toBe(true);
    expect(script).toContain(`shellwise-helper-${HELPER_HASH}-`);
  });
});

describe("the suggestion helper source", () => {
  test("is a PSReadLine predictor with a client for the daemon", () => {
    expect(HELPER_SOURCE).toContain("class ShellwisePredictor : ICommandPredictor");
    expect(HELPER_SOURCE).toContain("class ShellwiseClient");
  });

  test("hash is the first 12 hex chars of its sha256", () => {
    expect(HELPER_HASH).toBe(createHash("sha256").update(HELPER_SOURCE).digest("hex").slice(0, 12));
  });

  test("fits in a single-quoted here-string of an ASCII script", () => {
    expect(HELPER_SOURCE).toMatch(/^[\x00-\x7f]*$/);
    expect(HELPER_SOURCE.split("\n").some((l) => l.startsWith("'@"))).toBe(false);
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

  test.skipIf(SHELLS.length === 0)(
    "records a command when the environment has two names differing only in case",
    () => {
      // Windows PowerShell's .NET cannot copy such an environment for a child.
      const bin = join(dir, `${shell}-bin`);
      mkdirSync(bin, { recursive: true });
      const shim = join(bin, "shellwise.cmd");
      writeFileSync(shim, `@"${process.execPath}" "${ENTRY}" %*\r\n`);
      const f = scriptFile("case", generatePowerShellScript(NO_BIN, { socketPath: env.SHELLWISE_DAEMON_SOCKET, dataDir: dir }));
      const command = `echo case-dup-${shell}`;
      const p = Bun.spawnSync(
        [
          shell,
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            `Invoke-Expression (Get-Content -Raw '${f}')`,
            `$global:__sw.BinPath = '${shim}'`,
            "$now = Get-Date; $done = [System.Management.Automation.Runspaces.PipelineState]::Completed",
            `Add-History -InputObject ([pscustomobject]@{ CommandLine = '${command}'; ExecutionStatus = $done; StartExecutionTime = $now; EndExecutionTime = $now })`,
            "$null = prompt",
            // Whatever way the values reached the child, none stays behind here.
            "'left=' + (([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -like 'SW_ADD_*' }) -join ',')",
          ].join("; "),
        ],
        { env: { ...process.env, ...env, SW_CASE_dup: "a", SW_CASE_DUP: "b" } }
      );
      expect(p.stderr.toString().trim()).toBe("");
      expect(p.stdout.toString().trim()).toBe("left=");
      // Recording is fire-and-forget: poll for it.
      const deadline = Date.now() + 10_000;
      // (An exact match is never suggested: query by its prefix.)
      const recorded = () => cli(["suggest", "--query", "echo case-dup"]).out.split("\n").includes(command);
      while (!recorded() && Date.now() < deadline) Bun.sleepSync(100);
      expect(recorded()).toBe(true);
    },
    SHELL_TIMEOUT_MS
  );

  test.skipIf(SHELLS.length === 0)("keeps a non-ASCII path intact", () => {
    const sock = "C:\\Users\\Tuấn\\it's.sock";
    const f = scriptFile("ascii", generatePowerShellScript(NO_BIN, { socketPath: sock, dataDir: dir }));
    // Compare code points: the console code page would mangle printed text.
    const r = run(`Invoke-Expression (Get-Content -Raw '${f}'); ($global:__sw.Socket.ToCharArray() | ForEach-Object { [int]$_ }) -join ','`);
    expect(r.err).toBe("");
    expect(r.out).toBe([...sock].map((c) => c.charCodeAt(0)).join(","));
  }, SHELL_TIMEOUT_MS);
});

// The C# helper on its own: compiled in memory by pwsh, talking to a stand-in
// daemon that logs each request and sends a fixed reply.
describe.skipIf(Bun.which("pwsh") === null)("the suggestion helper in pwsh", () => {
  let csFile: string;
  let daemons = 0;
  beforeAll(() => {
    csFile = join(dir, "helper.cs");
    writeFileSync(csFile, HELPER_SOURCE);
  });

  function fakeDaemon(reply: string, delayMs = 0) {
    const n = ++daemons;
    const socket = join(dir, `fake-${n}.sock`);
    const log = join(dir, `fake-${n}.log`);
    writeFileSync(log, "");
    const proc = Bun.spawn([process.execPath, FAKE_DAEMON, socket, log, Buffer.from(reply).toString("base64"), String(delayMs)]);
    const deadline = Date.now() + 5000;
    while (!existsSync(socket) && Date.now() < deadline) Bun.sleepSync(20);
    return {
      socket,
      requests: () =>
        readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string),
      stop: () => proc.kill(),
    };
  }

  /** Runs `lines` in pwsh with the helper compiled; its output lines. */
  function pwsh(lines: string[]): string[] {
    const p = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", [`Add-Type -Path '${csFile}'`, ...lines].join("\n")], {
      env: { ...process.env, ...env },
    });
    expect(p.stderr.toString().trim()).toBe("");
    return p.stdout.toString().trim().split(/\r?\n/);
  }

  // `suggest '<input>'` prints the suggestions as text|tooltip, comma-separated,
  // or "none", then the time the call took.
  const predictor = (socket: string) => [
    `[ShellwisePredictor]::SocketPath = '${socket}'`,
    "$p = [ShellwisePredictor]::new()",
    "$c = [System.Management.Automation.Subsystem.Prediction.PredictionClient]::new('test', 'Terminal')",
    "function suggest($in) {",
    "  $sw = [Diagnostics.Stopwatch]::StartNew()",
    "  $pkg = $p.GetSuggestion($c, [System.Management.Automation.Subsystem.Prediction.PredictionContext]::Create($in), [Threading.CancellationToken]::None)",
    "  $ms = $sw.ElapsedMilliseconds",
    "  $s = if ($pkg.SuggestionEntries) { ($pkg.SuggestionEntries | ForEach-Object { $_.SuggestionText + '|' + $_.ToolTip }) -join ',' } else { 'none' }",
    "  \"$s ms=$ms\"",
    "}",
  ];
  const withoutTime = (lines: string[]) => lines.map((l) => l.replace(/ ms=\d+$/, ""));

  test("suggests what the daemon sends, without the input itself, with the source as tooltip", () => {
    const d = fakeDaemon("history\tgit status\nhistory\tgit st\ncommon\tgit stash pop\n\n");
    try {
      const out = pwsh([...predictor(d.socket), "suggest 'git st'", "suggest 'g'", 'suggest "git st`nx"', "suggest \"git`tst\""]);
      expect(withoutTime(out)).toEqual([
        "git status|history,git stash pop|common",
        // Too short, and a multi-line input: the daemon is not even asked.
        "none",
        "none",
        // A tab would split the protocol line: sent as a space.
        "git status|history,git st|history,git stash pop|common",
      ]);
      expect(d.requests()).toEqual(["SUGGEST\tgit st\t5\tv2", "SUGGEST\tgit st\t5\tv2"]);
    } finally {
      d.stop();
    }
  }, SHELL_TIMEOUT_MS);

  test("gives up within PSReadLine's budget when the daemon is slow or gone", () => {
    const slow = fakeDaemon("history\tgit status\n\n", 3000);
    try {
      const out = pwsh([
        ...predictor(slow.socket),
        // The first call also pays for JIT compiling the socket code.
        "$null = suggest 'git st'",
        "suggest 'git st'",
        `[ShellwisePredictor]::SocketPath = '${join(dir, "nobody.sock")}'`,
        "suggest 'git st'",
      ]);
      for (const line of out) {
        const [, s, ms] = line.match(/^(.*) ms=(\d+)$/)!;
        expect(s).toBe("none");
        // 15 ms is the timeout; the rest is slack for a loaded machine.
        expect(Number(ms)).toBeLessThan(100);
      }
      expect(out).toHaveLength(2);
    } finally {
      slow.stop();
    }
  }, SHELL_TIMEOUT_MS);

  test("Add sends one ADD line with tabs and line breaks as spaces, and reports the daemon's OK", () => {
    const d = fakeDaemon("OK\n\n");
    try {
      const out = pwsh([
        `[ShellwiseClient]::Add('${d.socket}', "echo\`ta", "C:\w\`r\`nx", 0, 12, 's-1', 'powershell')`,
        `[ShellwiseClient]::Add('${join(dir, "nobody.sock")}', 'echo b', 'C:\w', 0, 1, 's-1', 'powershell')`,
      ]);
      expect(out).toEqual(["True", "False"]);
      expect(d.requests()).toEqual(["ADD\techo a\tC:\w  x\t0\t12\ts-1\tpowershell"]);
    } finally {
      d.stop();
    }
  }, SHELL_TIMEOUT_MS);
});

describe.skipIf(Bun.which("pwsh") === null)("the helper's DLL cache", () => {
  test("shells starting at once share one DLL, and builds of other sources are removed", async () => {
    const data = join(dir, "cache ệ");
    const psDir = join(data, "ps");
    mkdirSync(psDir, { recursive: true });
    // An unlocked build of another source; not one of this source for another pwsh.
    writeFileSync(join(psDir, "shellwise-helper-000000000000-7.6.dll"), "old");
    writeFileSync(join(psDir, `shellwise-helper-${HELPER_HASH}-7.0.dll`), "other pwsh");
    const f = join(dir, "cache.ps1");
    writeFileSync(f, generatePowerShellScript(NO_BIN, { socketPath: join(dir, "x.sock"), dataDir: data }));
    // PSReadLine is not loaded in a non-interactive shell unless imported.
    const command = [
      "Import-Module PSReadLine",
      `Invoke-Expression (Get-Content -Raw '${f}')`,
      `'helper=' + $global:__sw.HasHelper + ' cached=' + ([System.IO.Path]::GetDirectoryName([ShellwisePredictor].Assembly.Location) -eq (Join-Path $global:__sw.DataDir 'ps'))`,
    ].join("; ");
    const shells = Array.from({ length: 4 }, () =>
      Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-Command", command], {
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      })
    );
    const results = await Promise.all(
      shells.map(async (p) => [(await new Response(p.stdout).text()).trim(), (await new Response(p.stderr).text()).trim()])
    );
    await Promise.all(shells.map((p) => p.exited));
    expect(results).toEqual(Array(4).fill(["helper=True cached=True", ""]));
    // This pwsh's build, and the other pwsh's one kept; no temp file left.
    const left = readdirSync(psDir).filter((n) => n !== `shellwise-helper-${HELPER_HASH}-7.0.dll`);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^shellwise-helper-[0-9a-f]{12}-7\.\d+\.dll$/);
    expect(left[0].startsWith(`shellwise-helper-${HELPER_HASH}-`)).toBe(true);
  }, SHELL_TIMEOUT_MS);
});
