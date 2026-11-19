import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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
    expect(script).toContain("function global:prompt");
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
  });

  test.skipIf(SHELLS.length === 0)("loads twice without errors and wraps the original prompt once", () => {
    const s = generatePowerShellScript(NO_BIN, { socketPath: join(dir, "x.sock"), dataDir: dir });
    const f = scriptFile("load", s);
    // Sourcing again (a reloaded profile) must not wrap our own wrapper: the
    // prompt would then call itself until the stack overflowed. Strict mode,
    // with no native command run yet, leaves $LASTEXITCODE unset: reading it
    // would throw.
    const load = `Invoke-Expression (Get-Content -Raw '${f}')`;
    const r = run(`Set-StrictMode -Version Latest; function prompt { 'orig> ' }; ${load}; ${load}; prompt; $Error.Count`);
    expect(r.err).toBe("");
    expect(r.out.split(/\r?\n/).map((l) => l.trimEnd())).toEqual(["orig>", "0"]);
  });

  test.skipIf(SHELLS.length === 0)("keeps a non-ASCII path intact", () => {
    const sock = "C:\\Users\\Tuấn\\it's.sock";
    const f = scriptFile("ascii", generatePowerShellScript(NO_BIN, { socketPath: sock, dataDir: dir }));
    // Compare code points: the console code page would mangle printed text.
    const r = run(`Invoke-Expression (Get-Content -Raw '${f}'); ($global:__sw.Socket.ToCharArray() | ForEach-Object { [int]$_ }) -join ','`);
    expect(r.err).toBe("");
    expect(r.out).toBe([...sock].map((c) => c.charCodeAt(0)).join(","));
  });
});
