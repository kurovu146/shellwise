#!/usr/bin/env bun
// package.json's postinstall / preuninstall: `bun scripts/install-hook.ts setup|uninstall`.
// Linux/macOS: runs setup.sh / uninstall.sh, as these hooks always did.
// Windows: adds/removes the shellwise block in each PowerShell's profile and
// starts/stops the daemon. Never fails the install.
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const MARKER = "# shellwise shell integration";
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

/** The line after the marker. Guarded: the profile keeps loading if shellwise is uninstalled without the hook. */
const initLine = (bin: string) =>
  `if (Get-Command ${bin} -ErrorAction SilentlyContinue) { ${bin} init powershell | Out-String | Invoke-Expression }`;

interface Profile {
  text: string;
  encode: (text: string) => Buffer;
}

/**
 * Decode a profile so that re-encoding the text gives back the same bytes.
 * UTF-16 (what Windows PowerShell's `>` writes) is decoded as such; anything
 * else (UTF-8 with or without BOM, or a legacy code page) as latin1, which
 * maps each byte to one char and back. The block is ASCII, so it comes out
 * right in UTF-8 and in any code page.
 */
function readProfile(path: string): Profile {
  const bytes = readFileSync(path);
  const bom = Buffer.from(bytes.subarray(0, 2));
  const le = bom[0] === 0xff && bom[1] === 0xfe;
  const be = bom[0] === 0xfe && bom[1] === 0xff;
  if ((le || be) && bytes.length % 2 !== 0) {
    throw new Error("looks like UTF-16 but has an odd number of bytes; left unchanged");
  }
  if (le) {
    return {
      text: bytes.subarray(2).toString("utf16le"),
      encode: (text) => Buffer.concat([bom, Buffer.from(text, "utf16le")]),
    };
  }
  if (be) {
    return {
      text: Buffer.from(bytes.subarray(2)).swap16().toString("utf16le"),
      encode: (text) => Buffer.concat([bom, Buffer.from(text, "utf16le").swap16()]),
    };
  }
  return { text: bytes.toString("latin1"), encode: (text) => Buffer.from(text, "latin1") };
}

// A UTF-8 BOM as readProfile's latin1 decoding shows it.
const UTF8_BOM = "\xEF\xBB\xBF";
/** Lines with their line endings attached, so joining them gives the text back. */
const splitLines = (text: string) => text.split(/(?<=\n)/).filter((l) => l !== "");
const stripBom = (text: string) => (text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text);
const isMarker = (line: string) => stripBom(line).trim() === MARKER;
// shellwise or sw, as typed or as a file (.exe, .cmd), with an optional path:
// bare, or in quotes where it may contain spaces (`& "C:\...\shellwise.exe"`).
const INIT_NAME = String.raw`(?:shellwise|sw)(?:\.exe|\.cmd)?`;
const INIT_PROGRAM = String.raw`(?:"(?:[^"]*[\\/])?${INIT_NAME}"|'(?:[^']*[\\/])?${INIT_NAME}'|(?:[^\s"'|;&(){}]*[\\/])?${INIT_NAME})`;
// Not part of a longer name (myshellwise, foo-sw, x.sw); any letter case and
// spacing, as PowerShell accepts them.
const INIT_RE = new RegExp(String.raw`(?:^|[^\w.-])${INIT_PROGRAM}\s+init\s+powershell\b`, "i");
/** A line running shellwise's (or sw's) PowerShell init, ours or hand-written; not a comment. */
const isInitLine = (line: string) => {
  const code = stripBom(line).trim();
  return !code.startsWith("#") && INIT_RE.test(code);
};

/**
 * Append the shellwise block to a PowerShell profile, creating it (and its
 * dirs) if needed. An existing profile is backed up to
 * `<profile>.shellwise-backup` first and keeps its bytes, encoding and line
 * endings; a new one is UTF-8 without BOM with CRLF, which both PowerShells
 * read. `bin` is the command name used in the block.
 */
export function addToProfile(profilePath: string, bin: string): "added" | "present" {
  if (!existsSync(profilePath)) {
    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, `${MARKER}\r\n${initLine(bin)}\r\n`);
    return "added";
  }
  const { text, encode } = readProfile(profilePath);
  // A hand-written init line (the documented manual set-up) counts too:
  // a second one would run the init script twice per start.
  if (splitLines(text).some((line) => isMarker(line) || isInitLine(line))) return "present";

  const eol = text.includes("\r\n") || !text.includes("\n") ? "\r\n" : "\n";
  const body = stripBom(text);
  // One blank line between the user's content and the block, never two.
  const separator = body === "" || /(^|\n)\r?\n$/.test(body) ? "" : body.endsWith("\n") ? eol : eol + eol;
  copyFileSync(profilePath, `${profilePath}.shellwise-backup`);
  writeFileSync(profilePath, encode(`${text}${separator}${MARKER}${eol}${initLine(bin)}${eol}`));
  return "added";
}

/**
 * Remove the marker line and the init line after it, keeping everything else
 * byte for byte. The line after the marker goes only if it is a shellwise
 * init line: one the user wrote there instead is not ours to delete. A
 * profile left with nothing but blank lines is deleted: an empty .ps1 still
 * fails to load where the execution policy blocks scripts. False when the
 * profile is missing or has no marker (the file is then not written).
 */
export function removeFromProfile(profilePath: string): boolean {
  if (!existsSync(profilePath)) return false;
  const { text, encode } = readProfile(profilePath);
  const lines = splitLines(text);
  const kept: string[] = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!isMarker(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    removed = true;
    // A BOM sits in front of the first line: keep it.
    if (lines[i].startsWith(UTF8_BOM)) kept.push(UTF8_BOM);
    if (isInitLine(lines[i + 1] ?? "")) i++;
  }
  if (!removed) return false;
  const rest = kept.join("");
  if (stripBom(rest).trim() === "") {
    unlinkSync(profilePath);
  } else {
    writeFileSync(profilePath, encode(rest));
  }
  return true;
}

export interface ShellProfile {
  /** $PROFILE.CurrentUserCurrentHost */
  profile: string;
  /** The effective execution policy of a fresh session; "" if it gave none. */
  policy: string;
}

/** Policies under which a shell loads an unsigned, locally written profile. */
const LOADS_PROFILE = new Set(["RemoteSigned", "Unrestricted", "Bypass"]);

/**
 * Ask a PowerShell for its current-user, current-host profile path and its
 * own effective execution policy; null if it cannot say.
 */
export function powershellProfile(shellPath: string, parentEnv: NodeJS.ProcessEnv = process.env): ShellProfile | null {
  // Not inherited: PSExecutionPolicyPreference carries a parent's
  // -ExecutionPolicy down (the Process scope), and pwsh's PSModulePath keeps
  // 5.1 from loading Get-ExecutionPolicy at all.
  const env = Object.fromEntries(
    Object.entries(parentEnv).filter(([key]) => !/^(PSExecutionPolicyPreference|PSModulePath)$/i.test(key))
  );
  // Base64 of the UTF-8 bytes: the path may hold letters the console code
  // page cannot carry through a pipe.
  // A policy it cannot read leaves the second line empty, not the profile unknown.
  const command =
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PROFILE.CurrentUserCurrentHost)); try { "$(Get-ExecutionPolicy)" } catch { "" }';
  try {
    const p = Bun.spawnSync([shellPath, "-NoProfile", "-NonInteractive", "-Command", command], {
      env,
      stdin: "ignore",
      stderr: "ignore",
      timeout: 30_000,
    });
    if (p.exitCode !== 0) return null;
    const [encoded = "", policy = ""] = p.stdout.toString().trim().split(/\r?\n/);
    const profile = Buffer.from(encoded.trim(), "base64").toString("utf8");
    return profile === "" ? null : { profile, policy: policy.trim() };
  } catch {
    return null;
  }
}

export interface HookDeps {
  platform: NodeJS.Platform;
  /** The directory of the package this hook belongs to. */
  packageDir: string;
  /** Resolve a command on PATH, as Bun.which. */
  which: (command: string) => string | null;
  /** A PowerShell's profile path and execution policy, from its executable's path. */
  profileOf: (shellPath: string) => ShellProfile | null;
  daemon: (action: "start" | "stop") => void;
  /** Run a POSIX install script with inherited stdio, ignoring failure. */
  runScript: (scriptPath: string) => void;
  log: (message: string) => void;
}

const defaultDeps: HookDeps = {
  platform: process.platform,
  packageDir: join(import.meta.dir, ".."),
  which: (command) => Bun.which(command),
  profileOf: (shellPath) => powershellProfile(shellPath),
  daemon: (action) => {
    // This package's own CLI, run by the bun running this hook: no PATH
    // lookup that could find another install or a .cmd shim.
    Bun.spawnSync([process.execPath, ENTRY, "daemon", action], { stdio: ["ignore", "ignore", "ignore"], timeout: 30_000 });
  },
  runScript: (scriptPath) => {
    Bun.spawnSync(["bash", scriptPath], { stdio: ["inherit", "inherit", "inherit"] });
  },
  log: (message) => console.log(message),
};

function runWindows(action: "setup" | "uninstall", deps: HookDeps): void {
  // A checkout or worktree (`bun install` / `npm install` there) is no
  // install at all: only a package under a node_modules segment (a global or
  // dependency install) may touch the user's profiles or daemon. Otherwise a
  // global shellwise on PATH would let the checkout's code run as the daemon.
  if (!/(^|[\\/])node_modules([\\/]|$)/i.test(deps.packageDir)) return;

  // Same rule as setup.sh: shellwise not on PATH, or found in a project's
  // node_modules\.bin (npm and bun put it on PATH for this hook), means a
  // local install, which gets no shell integration. Uninstall stops only for
  // the latter, so removing a project's copy leaves a global install alone.
  const self = deps.which("shellwise");
  const local = self !== null && /[\\/]node_modules[\\/]\.bin[\\/]/i.test(self);
  if (action === "setup" && (local || self === null)) {
    deps.log("[shellwise] This is a CLI tool — install it globally:\n  bun install -g shellwise\n  or: npm install -g shellwise");
    return;
  }
  if (local) return;

  const manual = `  ${initLine("shellwise")}`;
  let changed = false;
  for (const shell of ["pwsh", "powershell"]) {
    const shellPath = deps.which(shell);
    if (shellPath === null) continue;
    const info = deps.profileOf(shellPath);
    if (info === null) {
      if (action === "setup") deps.log(`[shellwise] Could not find ${shell}'s profile. Add this line to it:\n${manual}`);
      continue;
    }
    const { profile, policy } = info;
    try {
      if (action === "setup") {
        // A profile the shell refuses to load (Restricted, AllSigned, or no
        // answer) would print an error at every start: leave it to the user.
        // Removal below is never gated: it can only make loading succeed.
        if (!LOADS_PROFILE.has(policy)) {
          deps.log(
            `[shellwise] ${shell} does not run scripts (execution policy: ${policy || "unknown"}), so ${profile} was left alone.\n` +
              `  To enable: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned, then add this line to that profile:\n${manual}`
          );
          continue;
        }
        if (addToProfile(profile, "shellwise") === "added") {
          changed = true;
          deps.log(`[shellwise] Added to ${profile}`);
        } else {
          deps.log(`[shellwise] Already configured in ${profile}`);
        }
      } else if (removeFromProfile(profile)) {
        changed = true;
        deps.log(`[shellwise] Removed from ${profile}`);
      }
    } catch (e) {
      deps.log(`[shellwise] Could not update ${profile}: ${(e as Error).message}`);
    }
  }

  try {
    deps.daemon(action === "setup" ? "start" : "stop");
  } catch {}
  if (changed) {
    deps.log(
      action === "setup"
        ? "[shellwise] Restart PowerShell or run: . $PROFILE"
        : "[shellwise] Uninstalled. Restart PowerShell to complete."
    );
  }
}

/** Run the hook for `action`; never throws. */
export function runHook(action: string, deps: HookDeps = defaultDeps): void {
  if (action !== "setup" && action !== "uninstall") return;
  try {
    if (deps.platform === "win32") {
      runWindows(action, deps);
    } else {
      deps.runScript(join(import.meta.dir, action === "setup" ? "setup.sh" : "uninstall.sh"));
    }
  } catch {}
}

if (import.meta.main) {
  runHook(process.argv[2] ?? "");
  process.exit(0);
}
