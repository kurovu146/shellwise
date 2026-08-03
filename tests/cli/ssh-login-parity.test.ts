/**
 * `sw ssh` should feel like plain `ssh`.
 *
 * Two things used to differ: the host's message of the day never appeared
 * (because passing a remote command makes sshd skip it), and login-shell config
 * was skipped (`zsh -i` reads .zshrc but not .zprofile / .zlogin, and ZDOTDIR
 * points at a throwaway directory anyway).
 */
import { describe, test, expect } from "bun:test";
import { buildRemoteZshrc } from "../../src/cli/ssh";
import { hasZsh } from "./zsh-harness";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const zsh = hasZsh();

describe("remote session config", () => {
  const zshrc = buildRemoteZshrc("# INTEGRATION MARKER");

  test("reads login-shell config, not just .zshrc", () => {
    expect(zshrc).toContain("$HOME/.zprofile");
    expect(zshrc).toContain("$HOME/.zlogin");
  });

  test("keeps zsh's own load order", () => {
    // .zshenv → .zprofile → .zshrc → .zlogin
    expect(zshrc.indexOf("$HOME/.zshenv")).toBeLessThan(zshrc.indexOf("$HOME/.zprofile"));
    expect(zshrc.indexOf("$HOME/.zprofile")).toBeLessThan(zshrc.indexOf("$HOME/.zshrc"));
    expect(zshrc.indexOf("$HOME/.zshrc")).toBeLessThan(zshrc.indexOf("$HOME/.zlogin"));
  });

  test("prints the host's message of the day", () => {
    // sshd skips it when a remote command is given, so print it ourselves.
    expect(zshrc).toContain("/run/motd.dynamic");
    expect(zshrc).toContain("/etc/motd");
  });

  test("still loads shellwise last so its widgets win", () => {
    expect(zshrc.indexOf("# INTEGRATION MARKER")).toBeGreaterThan(zshrc.indexOf("$HOME/.zlogin"));
  });
});

describe.skipIf(!zsh)("a real zsh started this way", () => {
  test("ends up with everything the user's login shell would have set", () => {
    const home = mkdtempSync(join(tmpdir(), "sw-home-"));
    const zdot = mkdtempSync(join(tmpdir(), "sw-zdot-"));

    writeFileSync(join(home, ".zshenv"), 'export FROM_ZSHENV=yes\n');
    writeFileSync(join(home, ".zprofile"), 'export FROM_ZPROFILE=yes\nexport PATH="/opt/demo/bin:$PATH"\n');
    writeFileSync(join(home, ".zshrc"), 'export FROM_ZSHRC=yes\nPROMPT="custom%% "\n');
    writeFileSync(join(home, ".zlogin"), 'export FROM_ZLOGIN=yes\n');

    // A motd the fake host would show. The real paths are absolute, so this
    // only checks that the missing-file case stays quiet.
    writeFileSync(join(zdot, ".zshrc"), buildRemoteZshrc('print "INTEGRATION LOADED"'));

    const p = Bun.spawnSync(
      ["zsh", "-i", "-c", 'print "$FROM_ZSHENV/$FROM_ZPROFILE/$FROM_ZSHRC/$FROM_ZLOGIN/$PROMPT"'],
      { env: { ...process.env, HOME: home, ZDOTDIR: zdot } }
    );
    const out = p.stdout.toString();

    expect(out).toContain("yes/yes/yes/yes");
    expect(out).toContain("custom%");
    expect(out).toContain("INTEGRATION LOADED");
    // A host without /etc/motd must not spill errors into the session.
    expect(p.stderr.toString()).not.toContain("No such file");
  });

  test("survives a home directory with none of those files", () => {
    const home = mkdtempSync(join(tmpdir(), "sw-bare-home-"));
    const zdot = mkdtempSync(join(tmpdir(), "sw-bare-zdot-"));
    mkdirSync(join(home, "empty"), { recursive: true });
    writeFileSync(join(zdot, ".zshrc"), buildRemoteZshrc('print "INTEGRATION LOADED"'));

    const p = Bun.spawnSync(["zsh", "-i", "-c", 'print "ok"'], {
      env: { ...process.env, HOME: home, ZDOTDIR: zdot },
    });

    expect(p.stdout.toString()).toContain("INTEGRATION LOADED");
    expect(p.stdout.toString()).toContain("ok");
    expect(p.stderr.toString()).toBe("");
  });
});
