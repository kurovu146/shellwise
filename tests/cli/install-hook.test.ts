import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addToProfile, removeFromProfile, runHook, powershellProfile, type HookDeps } from "../../scripts/install-hook";

/**
 * Every profile here is a temp file passed in explicitly: nothing in this
 * file may read or write the real PowerShell profiles. The CLI's Windows flow
 * runs with injected profile discovery and daemon control.
 */
const MARKER = "# shellwise shell integration";
const INIT = "if (Get-Command shellwise -ErrorAction SilentlyContinue) { shellwise init powershell | Out-String | Invoke-Expression }";
const BLOCK_CRLF = `${MARKER}\r\n${INIT}\r\n`;
const BLOCK_LF = `${MARKER}\n${INIT}\n`;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sw-install-hook-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (p: string) => readFileSync(p);
function profileWith(content: string | Buffer, name = "profile.ps1"): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("addToProfile", () => {
  test("creates a missing profile and its parent dirs: the block only, UTF-8 without BOM, CRLF", () => {
    const p = join(dir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    expect(addToProfile(p, "shellwise")).toBe("added");
    expect(bytes(p).equals(Buffer.from(BLOCK_CRLF, "ascii"))).toBe(true);
    // Nothing to back up.
    expect(existsSync(`${p}.shellwise-backup`)).toBe(false);
  });

  test("appends after a blank line, keeps the original bytes and backs them up first", () => {
    const original = Buffer.from("Set-Alias ll Get-ChildItem\r\n$x = 'tiếng việt'\r\n", "utf8");
    const p = profileWith(original);
    expect(addToProfile(p, "shellwise")).toBe("added");
    expect(bytes(`${p}.shellwise-backup`).equals(original)).toBe(true);
    expect(bytes(p).equals(Buffer.concat([original, Buffer.from(`\r\n${BLOCK_CRLF}`)]))).toBe(true);
  });

  test("ends an unterminated last line before the blank line", () => {
    const p = profileWith("Import-Module posh-git");
    addToProfile(p, "shellwise");
    expect(bytes(p).toString("latin1")).toBe(`Import-Module posh-git\r\n\r\n${BLOCK_CRLF}`);
  });

  test("follows a profile's LF line endings", () => {
    const p = profileWith("Import-Module posh-git\n");
    addToProfile(p, "shellwise");
    expect(bytes(p).toString("latin1")).toBe(`Import-Module posh-git\n\n${BLOCK_LF}`);
  });

  test("does not add a second blank line after one that is already there", () => {
    const p = profileWith("a\r\n\r\n");
    addToProfile(p, "shellwise");
    expect(bytes(p).toString("latin1")).toBe(`a\r\n\r\n${BLOCK_CRLF}`);
  });

  test("an empty profile gets the block alone", () => {
    const p = profileWith("");
    addToProfile(p, "shellwise");
    expect(bytes(p).toString("latin1")).toBe(BLOCK_CRLF);
  });

  test("keeps a UTF-8 BOM", () => {
    const original = Buffer.concat([UTF8_BOM, Buffer.from("$a = 'ệ'\r\n", "utf8")]);
    const p = profileWith(original);
    addToProfile(p, "shellwise");
    expect(bytes(p).equals(Buffer.concat([original, Buffer.from(`\r\n${BLOCK_CRLF}`)]))).toBe(true);
  });

  test("writes the block in UTF-16LE into a UTF-16LE profile (what Windows PowerShell's > writes)", () => {
    const original = Buffer.concat([UTF16LE_BOM, Buffer.from("$a = 'ệ'\r\n", "utf16le")]);
    const p = profileWith(original);
    addToProfile(p, "shellwise");
    const after = bytes(p);
    expect(after.subarray(0, original.length).equals(original)).toBe(true);
    expect(after.subarray(original.length).toString("utf16le")).toBe(`\r\n${BLOCK_CRLF}`);
  });

  test("writes the block in UTF-16BE into a UTF-16BE profile, and removes it again", () => {
    const be = (s: string) => Buffer.from(s, "utf16le").swap16();
    const original = Buffer.concat([Buffer.from([0xfe, 0xff]), be("$a = 'ệ'\r\n")]);
    const p = profileWith(original);
    addToProfile(p, "shellwise");
    expect(bytes(p).equals(Buffer.concat([original, be(`\r\n${BLOCK_CRLF}`)]))).toBe(true);
    expect(removeFromProfile(p)).toBe(true);
    expect(bytes(p).equals(Buffer.concat([original, be("\r\n")]))).toBe(true);
  });

  test("leaves a profile alone that starts like UTF-16 but has an odd length", () => {
    const original = Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x0a]);
    const p = profileWith(original);
    expect(() => addToProfile(p, "shellwise")).toThrow();
    expect(bytes(p).equals(original)).toBe(true);
  });

  test("keeps bytes of a legacy code page profile it cannot decode as UTF-8", () => {
    // "café" in Windows-1252: 0xE9 alone is not valid UTF-8.
    const original = Buffer.from([0x24, 0x63, 0x3d, 0x27, 0x63, 0x61, 0x66, 0xe9, 0x27, 0x0d, 0x0a]);
    const p = profileWith(original);
    addToProfile(p, "shellwise");
    expect(bytes(p).equals(Buffer.concat([original, Buffer.from(`\r\n${BLOCK_CRLF}`)]))).toBe(true);
  });

  test("a second call reports present and changes neither the profile nor the backup", () => {
    const p = profileWith("a\r\n");
    expect(addToProfile(p, "shellwise")).toBe("added");
    const once = bytes(p);
    const backup = bytes(`${p}.shellwise-backup`);
    expect(addToProfile(p, "shellwise")).toBe("present");
    expect(bytes(p).equals(once)).toBe(true);
    expect(bytes(`${p}.shellwise-backup`).equals(backup)).toBe(true);
  });

  test("a hand-written init line without the marker counts as present; a commented-out one does not", () => {
    const own = profileWith("Import-Module posh-git\r\nshellwise init powershell | Out-String | Invoke-Expression\r\n");
    const before = bytes(own);
    expect(addToProfile(own, "shellwise")).toBe("present");
    expect(bytes(own).equals(before)).toBe(true);
    expect(existsSync(`${own}.shellwise-backup`)).toBe(false);

    const commented = profileWith("# shellwise init powershell | Out-String | Invoke-Expression\r\n", "commented.ps1");
    expect(addToProfile(commented, "shellwise")).toBe("added");
  });

  test("finds the block in the middle of other content, in UTF-16LE too", () => {
    const text = `a\r\n${BLOCK_CRLF}b\r\n`;
    const p = profileWith(Buffer.concat([UTF16LE_BOM, Buffer.from(text, "utf16le")]));
    const before = bytes(p);
    expect(addToProfile(p, "shellwise")).toBe("present");
    expect(bytes(p).equals(before)).toBe(true);
  });
});

describe("removeFromProfile", () => {
  test("removes the marker line and the line after it from the middle of a profile", () => {
    const p = profileWith(`a\r\n\r\n${BLOCK_CRLF}b\r\n`);
    expect(removeFromProfile(p)).toBe(true);
    expect(bytes(p).toString("latin1")).toBe("a\r\n\r\nb\r\n");
    expect(removeFromProfile(p)).toBe(false);
    expect(bytes(p).toString("latin1")).toBe("a\r\n\r\nb\r\n");
  });

  test("returns false and leaves the file alone when the marker is absent", () => {
    const p = profileWith("a\r\nshellwise init powershell | Out-String | Invoke-Expression\r\n");
    const before = statSync(p).mtimeMs;
    expect(removeFromProfile(p)).toBe(false);
    expect(bytes(p).toString("latin1")).toBe("a\r\nshellwise init powershell | Out-String | Invoke-Expression\r\n");
    expect(statSync(p).mtimeMs).toBe(before);
  });

  test("returns false for a missing profile", () => {
    expect(removeFromProfile(join(dir, "nope", "profile.ps1"))).toBe(false);
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });

  test("keeps the encoding and the other bytes of a UTF-16LE profile", () => {
    const p = profileWith(Buffer.concat([UTF16LE_BOM, Buffer.from(`$a = 'ệ'\r\n${BLOCK_CRLF}$b = 1\r\n`, "utf16le")]));
    expect(removeFromProfile(p)).toBe(true);
    expect(bytes(p).equals(Buffer.concat([UTF16LE_BOM, Buffer.from("$a = 'ệ'\r\n$b = 1\r\n", "utf16le")]))).toBe(true);
  });

  test("keeps the bytes of a UTF-8 BOM profile and of a legacy code page profile", () => {
    const utf8 = profileWith(Buffer.concat([UTF8_BOM, Buffer.from(`${BLOCK_CRLF}$a = 'ệ'\r\n`, "utf8")]), "bom.ps1");
    expect(removeFromProfile(utf8)).toBe(true);
    expect(bytes(utf8).equals(Buffer.concat([UTF8_BOM, Buffer.from("$a = 'ệ'\r\n", "utf8")]))).toBe(true);

    const legacy = profileWith(Buffer.concat([Buffer.from([0x63, 0xe9, 0x0a]), Buffer.from(BLOCK_LF)]), "legacy.ps1");
    expect(removeFromProfile(legacy)).toBe(true);
    expect(bytes(legacy).equals(Buffer.from([0x63, 0xe9, 0x0a]))).toBe(true);
  });

  test("leaves the line after the marker when it is not the init line (the user removed it)", () => {
    const p = profileWith(`${MARKER}\r\nImport-Module posh-git\r\n`);
    expect(removeFromProfile(p)).toBe(true);
    expect(bytes(p).toString("latin1")).toBe("Import-Module posh-git\r\n");
  });

  test("leaves another tool's init line after the marker: only a shellwise or sw init line is ours", () => {
    const zoxide = "Invoke-Expression (& { (zoxide init powershell | Out-String) })";
    const starship = "Invoke-Expression (&starship init powershell)";
    const p = profileWith(`${MARKER}\r\n${zoxide}\r\n${MARKER}\r\n${starship}\r\n`);
    expect(removeFromProfile(p)).toBe(true);
    expect(bytes(p).toString("latin1")).toBe(`${zoxide}\r\n${starship}\r\n`);

    const sw = profileWith(`a\r\n${MARKER}\r\nsw init powershell | Out-String | Invoke-Expression\r\n`, "sw.ps1");
    expect(removeFromProfile(sw)).toBe(true);
    expect(bytes(sw).toString("latin1")).toBe("a\r\n");
  });

  test("deletes a profile that holds nothing but the block", () => {
    for (const [name, content] of [
      ["plain.ps1", BLOCK_CRLF],
      ["blank-lines.ps1", `\r\n \r\n${BLOCK_CRLF}\r\n`],
      ["utf8-bom.ps1", Buffer.concat([UTF8_BOM, Buffer.from(BLOCK_CRLF)])],
      ["utf16.ps1", Buffer.concat([UTF16LE_BOM, Buffer.from(BLOCK_CRLF, "utf16le")])],
    ] as const) {
      const p = profileWith(content, name);
      expect(removeFromProfile(p)).toBe(true);
      expect(existsSync(p)).toBe(false);
    }
  });

  test("add and remove can repeat without the profile growing", () => {
    const p = profileWith("a\r\n");
    addToProfile(p, "shellwise");
    removeFromProfile(p);
    const once = bytes(p);
    addToProfile(p, "shellwise");
    removeFromProfile(p);
    expect(bytes(p).equals(once)).toBe(true);
  });
});

describe("runHook", () => {
  const GLOBAL_PACKAGE = "C:\\Users\\me\\.bun\\install\\global\\node_modules\\shellwise";
  const PWSH = "C:\\pwsh\\pwsh.exe";
  const WINPS = "C:\\Windows\\powershell.exe";

  /** Fake deps: two shells with temp profiles, every call and log line recorded. */
  function fakeDeps(over: Partial<HookDeps> = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const profiles: Record<string, string> = {
      [PWSH]: join(dir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
      [WINPS]: join(dir, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    };
    const policies: Record<string, string> = { [PWSH]: "RemoteSigned", [WINPS]: "RemoteSigned" };
    const shells: Record<string, string> = {
      shellwise: "C:\\Users\\me\\.bun\\bin\\shellwise.exe",
      pwsh: PWSH,
      powershell: WINPS,
    };
    const deps: HookDeps = {
      platform: "win32",
      packageDir: GLOBAL_PACKAGE,
      which: (cmd) => shells[cmd] ?? null,
      profileOf: (shell) => {
        calls.push(`profileOf ${shell}`);
        return profiles[shell] ? { profile: profiles[shell], policy: policies[shell] } : null;
      },
      daemon: (action) => calls.push(`daemon ${action}`),
      runScript: (script) => calls.push(`script ${script}`),
      log: (message) => logs.push(message),
      ...over,
    };
    return { deps, calls, logs, profiles, policies, shells };
  }

  test("on Linux and macOS runs setup.sh / uninstall.sh and nothing else", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const { deps, calls } = fakeDeps({ platform });
      runHook("setup", deps);
      runHook("uninstall", deps);
      expect(calls).toEqual([
        `script ${join(import.meta.dir, "..", "..", "scripts", "setup.sh")}`,
        `script ${join(import.meta.dir, "..", "..", "scripts", "uninstall.sh")}`,
      ]);
    }
  });

  test("on Windows setup adds the block to each shell's profile, then starts the daemon", () => {
    const { deps, calls, logs, profiles } = fakeDeps();
    runHook("setup", deps);
    for (const p of Object.values(profiles)) {
      expect(bytes(p).toString("latin1")).toBe(BLOCK_CRLF);
    }
    expect(calls.at(-1)).toBe("daemon start");
    expect(calls.filter((c) => c.startsWith("daemon"))).toEqual(["daemon start"]);
    expect(logs.at(-1)).toContain("Restart PowerShell");
  });

  test("on Windows uninstall removes the block from each profile, then stops the daemon", () => {
    const { deps, calls, logs, profiles } = fakeDeps();
    for (const p of Object.values(profiles)) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, `a\r\n\r\n${BLOCK_CRLF}b\r\n`);
    }
    runHook("uninstall", deps);
    for (const p of Object.values(profiles)) {
      expect(bytes(p).toString("latin1")).toBe("a\r\n\r\nb\r\n");
    }
    expect(calls.at(-1)).toBe("daemon stop");
    expect(logs.at(-1)).toContain("Uninstalled");
  });

  test("on Windows setup leaves the profile of a shell whose policy blocks scripts alone and prints the line to add", () => {
    for (const policy of ["Restricted", "AllSigned", "Undefined", ""]) {
      const { deps, calls, logs, profiles, policies } = fakeDeps();
      policies[WINPS] = policy;
      // An existing profile is left as it is too: no block, no backup.
      mkdirSync(join(profiles[WINPS], ".."), { recursive: true });
      writeFileSync(profiles[WINPS], "Set-Alias ll Get-ChildItem\r\n");
      runHook("setup", deps);
      expect(bytes(profiles[WINPS]).toString("latin1")).toBe("Set-Alias ll Get-ChildItem\r\n");
      expect(existsSync(`${profiles[WINPS]}.shellwise-backup`)).toBe(false);
      expect(bytes(profiles[PWSH]).toString("latin1")).toBe(BLOCK_CRLF);
      expect(logs.join("\n")).toContain(INIT);
      expect(calls.at(-1)).toBe("daemon start");
      rmSync(join(dir, "Documents"), { recursive: true, force: true });
    }
  });

  test("on Windows setup creates no profile for a shell whose policy blocks scripts", () => {
    for (const policy of ["Unrestricted", "Bypass", "Restricted"]) {
      const { deps, profiles, policies } = fakeDeps();
      policies[WINPS] = policy;
      runHook("setup", deps);
      expect(existsSync(profiles[WINPS])).toBe(policy !== "Restricted");
      rmSync(join(dir, "Documents"), { recursive: true, force: true });
    }
  });

  test("on Windows uninstall still removes the block under a blocking policy, and deletes a profile left empty", () => {
    const { deps, profiles, policies } = fakeDeps();
    policies[WINPS] = "Restricted";
    mkdirSync(join(profiles[WINPS], ".."), { recursive: true });
    writeFileSync(profiles[WINPS], BLOCK_CRLF);
    runHook("uninstall", deps);
    expect(existsSync(profiles[WINPS])).toBe(false);
  });

  test("on Windows a checkout (the hook's package is not under node_modules) is left alone", () => {
    for (const packageDir of ["C:\\work\\shellwise", "C:\\work\\my_node_modules\\shellwise", "C:\\node_modules2\\shellwise"]) {
      for (const action of ["setup", "uninstall"]) {
        const { deps, calls, logs, profiles } = fakeDeps({ packageDir });
        runHook(action, deps);
        expect(calls).toEqual([]);
        expect(logs).toEqual([]);
        for (const p of Object.values(profiles)) expect(existsSync(p)).toBe(false);
      }
    }
  });

  test("on Windows a package under a node_modules segment (either separator, any case) is set up", () => {
    for (const packageDir of ["C:\\Users\\me\\AppData\\Roaming\\npm\\Node_Modules\\shellwise", "C:/a/node_modules/shellwise"]) {
      const { deps, profiles } = fakeDeps({ packageDir });
      runHook("setup", deps);
      expect(existsSync(profiles[PWSH])).toBe(true);
      rmSync(join(dir, "Documents"), { recursive: true, force: true });
    }
  });

  test("on Windows a local install (shellwise resolves into node_modules\\.bin) touches nothing", () => {
    for (const action of ["setup", "uninstall"]) {
      const { deps, calls, shells, profiles } = fakeDeps();
      shells.shellwise = "C:\\work\\app\\node_modules\\.bin\\shellwise.exe";
      runHook(action, deps);
      expect(calls).toEqual([]);
      for (const p of Object.values(profiles)) expect(existsSync(p)).toBe(false);
    }
  });

  test("on Windows setup touches nothing when shellwise is not on PATH", () => {
    const { deps, calls, shells, profiles } = fakeDeps();
    delete shells.shellwise;
    runHook("setup", deps);
    expect(calls).toEqual([]);
    for (const p of Object.values(profiles)) expect(existsSync(p)).toBe(false);
  });

  test("on Windows skips a shell that is not installed", () => {
    const { deps, calls, shells, profiles } = fakeDeps();
    delete shells.powershell;
    runHook("setup", deps);
    expect(calls).toEqual([`profileOf ${PWSH}`, "daemon start"]);
    expect(bytes(profiles[PWSH]).toString("latin1")).toBe(BLOCK_CRLF);
    expect(existsSync(profiles[WINPS])).toBe(false);
  });

  test("on Windows skips shells that report no profile and still starts the daemon", () => {
    const { deps, calls } = fakeDeps({ profileOf: () => null });
    runHook("setup", deps);
    expect(calls).toEqual(["daemon start"]);
  });

  test("on Windows prints no closing message when nothing changed", () => {
    const setup = fakeDeps({ profileOf: () => null });
    runHook("setup", setup.deps);
    expect(setup.logs.join("\n")).not.toContain("Restart PowerShell");

    const present = fakeDeps();
    runHook("setup", present.deps);
    present.logs.length = 0;
    runHook("setup", present.deps);
    expect(present.logs.join("\n")).not.toContain("Restart PowerShell");

    rmSync(join(dir, "Documents"), { recursive: true, force: true });
    const uninstall = fakeDeps();
    runHook("uninstall", uninstall.deps);
    expect(uninstall.logs.join("\n")).not.toContain("Uninstalled");
  });

  test("on Windows a profile that cannot be written does not stop the other shell or the daemon", () => {
    const { deps, calls, profiles } = fakeDeps();
    // pwsh's profile path is a directory: reading it fails.
    mkdirSync(profiles[PWSH], { recursive: true });
    expect(() => runHook("setup", deps)).not.toThrow();
    expect(bytes(profiles[WINPS]).toString("latin1")).toBe(BLOCK_CRLF);
    expect(calls.at(-1)).toBe("daemon start");
  });

  test("an unknown action does nothing", () => {
    const { deps, calls } = fakeDeps();
    runHook("bogus", deps);
    expect(calls).toEqual([]);
  });
});

describe.skipIf(process.platform !== "win32")("powershellProfile", () => {
  const POLICY = /^(Restricted|AllSigned|RemoteSigned|Unrestricted|Bypass)$/;
  /** The parent's env without what a shell hands its children: what a fresh shell reports. */
  const ownEnv = () =>
    Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PSExecutionPolicyPreference|PSModulePath)$/i.test(k)));

  // Read-only: asks each installed shell for its profile path and policy.
  for (const shell of ["pwsh", "powershell"]) {
    const path = Bun.which(shell);
    test.skipIf(path === null)(
      `asks ${shell} for its current-user, current-host profile and its own execution policy`,
      () => {
        const own = Bun.spawnSync([path!, "-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"], { env: ownEnv() })
          .stdout.toString()
          .trim();
        expect(own).toMatch(POLICY);
        // A parent run with -ExecutionPolicy passes it down in
        // PSExecutionPolicyPreference, and pwsh passes its PSModulePath, which
        // keeps 5.1 from loading Get-ExecutionPolicy at all.
        const inherited = own === "AllSigned" ? "Bypass" : "AllSigned";
        const info = powershellProfile(path!, { ...process.env, PSExecutionPolicyPreference: inherited });
        expect(info?.profile).toMatch(/[\\/](PowerShell|WindowsPowerShell)[\\/]Microsoft\.PowerShell_profile\.ps1$/);
        expect(info?.profile).toContain(shell === "pwsh" ? "\\PowerShell\\" : "\\WindowsPowerShell\\");
        expect(info?.policy).toBe(own);
      },
      30_000
    );
  }

  test("reports nothing for a program that is not a PowerShell", () => {
    expect(powershellProfile(join(dir, "missing.exe"))).toBeNull();
  }, 30_000);
});

describe("the package.json hook lines", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
  const fallback = (action: string, script: string) =>
    `bun scripts/install-hook.ts ${action} || node -e "process.platform==='win32'||require('child_process').spawnSync('bash',['scripts/${script}'],{stdio:'inherit'})" || exit 0`;

  test("run the hook, fall back to the POSIX script through node when bun is missing, and never fail", () => {
    expect(pkg.scripts.postinstall).toBe(fallback("setup", "setup.sh"));
    expect(pkg.scripts.preuninstall).toBe(fallback("uninstall", "uninstall.sh"));
  });

  const node = Bun.which("node");
  // On Windows Git's bash is often installed but not on PATH.
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const bash = Bun.which("bash") ?? (process.platform === "win32" && existsSync(gitBash) ? gitBash : null);

  /**
   * Run `line` the way npm does (cmd.exe /d /s /c on Windows, sh -c
   * elsewhere) in a package whose scripts/setup.sh only records that it ran
   * and fails, with a PATH that has node (and bash) but no bun.
   */
  function runLine(line: string) {
    const pkgDir = join(dir, "pkg");
    mkdirSync(join(pkgDir, "scripts"), { recursive: true });
    writeFileSync(join(pkgDir, "scripts", "setup.sh"), `echo ran > "${join(pkgDir, "ran.txt").replace(/\\/g, "/")}"\nexit 3\n`);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const dirs = [node!, bash!].map((p) => join(p, ".."));
    if (process.platform !== "win32") dirs.push("/usr/bin", "/bin");
    const PATH = [...new Set(dirs)].join(process.platform === "win32" ? ";" : ":");
    expect(Bun.which("bun", { PATH })).toBeNull();
    const env = { ...process.env, [pathKey]: PATH };
    const p =
      process.platform === "win32"
        ? Bun.spawnSync([process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"${line}"`], {
            cwd: pkgDir,
            env,
            windowsVerbatimArguments: true,
          })
        : Bun.spawnSync(["sh", "-c", line], { cwd: pkgDir, env });
    return { exitCode: p.exitCode, ran: existsSync(join(pkgDir, "ran.txt")) };
  }

  // On Windows bash is on that PATH too: available, it must still not run.
  test.skipIf(node === null || bash === null)(
    "without bun: bash setup.sh runs on POSIX, nothing runs on Windows, and the line exits 0",
    () => {
      expect(runLine(pkg.scripts.postinstall)).toEqual({ exitCode: 0, ran: process.platform !== "win32" });
    },
    30_000
  );

  test.skipIf(process.platform !== "win32" || node === null || bash === null)(
    "on Windows the same line with the platform test made false does reach bash (the fallback is wired)",
    () => {
      const line = pkg.scripts.postinstall.replace("process.platform==='win32'", "false");
      expect(line).not.toBe(pkg.scripts.postinstall);
      expect(runLine(line)).toEqual({ exitCode: 0, ran: true });
    },
    30_000
  );
});

describe.skipIf(process.platform !== "win32")("a profile written by addToProfile, loaded by each PowerShell", () => {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const VALUE = "tiếng việt";

  /** Dot-source `profile` in `shell`; returns $v and whether the init ran, as UTF-8 via base64. */
  function load(shell: string, profile: string, path: string) {
    const report =
      "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(\"$v|$(Get-Variable swLoaded -ValueOnly -ErrorAction Ignore)\"))";
    const p = Bun.spawnSync([shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `. '${profile}'; ${report}`], {
      env: { ...process.env, [pathKey]: path },
    });
    return { out: Buffer.from(p.stdout.toString().trim(), "base64").toString("utf8"), err: p.stderr.toString() };
  }

  for (const shell of ["pwsh", "powershell"]) {
    test.skipIf(Bun.which(shell) === null || Bun.which("shellwise") !== null)(
      `${shell} reads the user's UTF-16LE content and runs the block only when shellwise is on PATH`,
      () => {
        const p = profileWith(Buffer.concat([UTF16LE_BOM, Buffer.from(`$v = '${VALUE}'\r\n`, "utf16le")]));
        addToProfile(p, "shellwise");
        expect(load(shell, p, process.env[pathKey]!)).toEqual({ out: `${VALUE}|`, err: "" });

        // A stand-in for the real CLI: what `init powershell` prints is run.
        const bin = join(dir, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "shellwise.cmd"), "@echo $global:swLoaded = '%1 %2'\r\n");
        expect(load(shell, p, `${bin};${process.env[pathKey]}`)).toEqual({ out: `${VALUE}|init powershell`, err: "" });
      },
      30_000
    );
  }
});

test("the CLI exits 0 for an unknown action", () => {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "..", "scripts", "install-hook.ts"), "bogus"]);
  expect(p.exitCode).toBe(0);
});
