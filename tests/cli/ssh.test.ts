import { describe, test, expect, spyOn } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildRemoteZshrc, buildRemoteCommand, buildSshArgs, runSsh } from "../../src/cli/ssh";
import { removeDir } from "../win/console-harness";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const WINDOWS_MESSAGE = "shellwise ssh is not supported on Windows yet.";

describe("ssh on Windows", () => {
  test("refuses with one line on stderr before anything else, even the usage", async () => {
    // Should it get further, it must find no daemon at an endpoint of its own,
    // never the default one.
    const dir = mkdtempSync(join(tmpdir(), "sw-ssh-unit-"));
    const saved = process.env.SHELLWISE_DAEMON_SOCKET;
    process.env.SHELLWISE_DAEMON_SOCKET = join(dir, "d.sock");
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    try {
      expect(await runSsh(["vps.example.com"], { platform: "win32" })).toBe(1);
      expect(await runSsh([], { platform: "win32" })).toBe(1);
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.SHELLWISE_DAEMON_SOCKET;
      else process.env.SHELLWISE_DAEMON_SOCKET = saved;
      removeDir(dir);
    }
    expect(errors).toEqual([WINDOWS_MESSAGE, WINDOWS_MESSAGE]);
  });

  test("elsewhere it goes on as before (here: the usage, with no host)", async () => {
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    try {
      expect(await runSsh([], { platform: "linux" })).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith("Usage: shellwise ssh");
  });

  test.skipIf(process.platform !== "win32")("`sw ssh` exits 1 with that line and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-ssh-win-"));
    try {
      const p = Bun.spawnSync([process.execPath, ENTRY, "ssh", "vps.example.com"], {
        env: {
          ...process.env,
          XDG_DATA_HOME: join(dir, "data"),
          XDG_CONFIG_HOME: join(dir, "config"),
          SHELLWISE_DAEMON_SOCKET: join(dir, "d.sock"),
        },
      });
      expect({ code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString().trim() }).toEqual({
        code: 1,
        out: "",
        err: WINDOWS_MESSAGE,
      });
    } finally {
      removeDir(dir);
    }
  });
});

describe("buildRemoteZshrc", () => {
  const zshrc = buildRemoteZshrc("# INTEGRATION MARKER");

  test("restores ZDOTDIR so the user's own config resolves normally", () => {
    expect(zshrc).toContain("ZDOTDIR=$HOME");
  });

  test("sources the user's real config", () => {
    expect(zshrc).toContain("$HOME/.zshrc");
    expect(zshrc).toContain("$HOME/.zshenv");
  });

  test("loads shellwise after the user's config so its widgets win", () => {
    expect(zshrc.indexOf("# INTEGRATION MARKER")).toBeGreaterThan(zshrc.indexOf("$HOME/.zshrc"));
  });
});

describe("buildRemoteCommand", () => {
  const command = buildRemoteCommand({
    zshrc: "echo hello",
    socketPath: "/tmp/sw-remote-abc.sock",
  });

  test("ships the config as base64 so quotes in it cannot break the command", () => {
    const encoded = Buffer.from("echo hello").toString("base64");
    expect(command).toContain(encoded);
    expect(command).not.toContain("echo hello");
  });

  test("survives a config containing both quote styles", () => {
    const nasty = `alias x='don"t; rm -rf /'`;
    const cmd = buildRemoteCommand({ zshrc: nasty, socketPath: "/tmp/s.sock" });
    const payload = cmd.match(/'([A-Za-z0-9+/=]+)'/)?.[1];
    expect(payload).toBeDefined();
    expect(Buffer.from(payload!, "base64").toString()).toBe(nasty);
  });

  test("points the integration at the forwarded socket", () => {
    expect(command).toContain("SHELLWISE_SOCKET=/tmp/sw-remote-abc.sock");
  });

  test("runs zsh from a throwaway ZDOTDIR", () => {
    expect(command).toContain("ZDOTDIR=");
    expect(command).toContain("zsh -i");
  });

  test("falls back to a normal shell when the host has no zsh", () => {
    expect(command).toContain("command -v zsh");
    expect(command).toContain("exec");
  });

  test("cleans up the temp dir and the forwarded socket on exit", () => {
    expect(command).toContain("rm -rf");
    expect(command).toContain("rm -f /tmp/sw-remote-abc.sock");
  });

  test("decodes base64 portably across GNU and BSD", () => {
    // BSD/macOS base64 rejects a positional input file — feed it on stdin.
    expect(command).toContain("base64 -d <");
    expect(command).toContain("base64 -D <");
    // openssl needs -A for a single long line.
    expect(command).toContain("openssl base64 -d -A");
  });

  test("checks that the staged config is non-empty before starting zsh", () => {
    expect(command).toContain('-s "$d/.zshrc"');
  });
});

// Runs the real remote command through /bin/sh. This is the only check that
// catches a decoder that silently writes an empty .zshrc — which would drop the
// user into a zsh with none of their own config loaded.
describe("buildRemoteCommand — executed for real", () => {
  // Detected by capability, not platform: Windows has no POSIX sh unless one is installed.
  const shAvailable = Bun.which("sh") !== null;
  const zshAvailable = shAvailable && Bun.which("zsh") !== null;
  const stubToolsAvailable = shAvailable && Bun.which("ln") !== null && Bun.which("chmod") !== null;

  test.if(zshAvailable)("the remote zsh actually loads the shipped config", async () => {
    const command = buildRemoteCommand({
      zshrc: `${buildRemoteZshrc('__sw_marker() { print "SHIPPED-CONFIG-LOADED" }')}`,
      socketPath: `/tmp/sw-test-exec-${process.pid}.sock`,
    });

    const proc = Bun.spawn(["sh", "-c", command], {
      stdin: new Blob(["__sw_marker\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    expect(out).toContain("SHIPPED-CONFIG-LOADED");
  });

  test.if(shAvailable && stubToolsAvailable)("drops into the host's own shell when zsh is missing", async () => {
    // A clean Ubuntu/Debian server has bash and dash but no zsh, so this is a
    // common path, not an edge case.
    const stubDir = `/tmp/sw-test-nozsh-${process.pid}`;
    Bun.spawnSync(["mkdir", "-p", stubDir]);
    for (const tool of ["mktemp", "base64", "rm", "sh", "openssl"]) {
      const real = Bun.spawnSync(["sh", "-c", `command -v ${tool}`]).stdout.toString().trim();
      if (real) Bun.spawnSync(["ln", "-sf", real, `${stubDir}/${tool}`]);
    }
    const sock = `/tmp/sw-test-nozsh-${process.pid}.sock`;

    const proc = Bun.spawn([Bun.which("sh") ?? "sh", "-c", buildRemoteCommand({ zshrc: "# unused", socketPath: sock })], {
      env: { PATH: stubDir, SHELL: "/bin/sh", HOME: process.env.HOME ?? "/tmp" },
      stdin: new Blob(["echo LANDED-IN=$0\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    Bun.spawnSync(["rm", "-rf", stubDir]);

    expect(err).toContain("zsh not found");
    // Tell the user how to get suggestions, not just that they don't have them.
    expect(err).toContain("install zsh");
    expect(out).toContain("LANDED-IN=/bin/sh");
    expect(exitCode).toBe(0);
  });

  test.if(zshAvailable && stubToolsAvailable)("falls back to a normal shell when no decoder works", async () => {
    // Shadow every decoder with a failing stub, the way a stripped-down host
    // without base64 or openssl would behave.
    const stubDir = `/tmp/sw-test-stub-${process.pid}`;
    Bun.spawnSync(["mkdir", "-p", stubDir]);
    for (const name of ["base64", "openssl"]) {
      Bun.spawnSync(["sh", "-c", `printf '#!/bin/sh\\nexit 1\\n' > ${stubDir}/${name}`]);
      Bun.spawnSync(["chmod", "+x", `${stubDir}/${name}`]);
    }

    const command = buildRemoteCommand({
      zshrc: buildRemoteZshrc("# whatever"),
      socketPath: `/tmp/sw-test-nodecode-${process.pid}.sock`,
    });

    const proc = Bun.spawn(["sh", "-c", command], {
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, SHELL: "/bin/sh" },
      stdin: new Blob(["exit\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    Bun.spawnSync(["rm", "-rf", stubDir]);

    expect(err).toContain("could not stage the remote config");
  });
});

describe("buildSshArgs", () => {
  const args = buildSshArgs({
    userArgs: ["-p", "2222", "vps.example.com"],
    localSocket: "/tmp/local.sock",
    remoteSocket: "/tmp/remote.sock",
    remoteCommand: "REMOTE_CMD",
  });

  test("forces a TTY because the remote shell is interactive", () => {
    expect(args).toContain("-t");
  });

  test("reverse-forwards the remote socket to the local proxy", () => {
    const idx = args.indexOf("-R");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/tmp/remote.sock:/tmp/local.sock");
  });

  test("keeps the user's own ssh flags and host", () => {
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
    expect(args).toContain("vps.example.com");
  });

  test("puts the remote command last", () => {
    expect(args[args.length - 1]).toBe("REMOTE_CMD");
  });

  test("keeps user flags ahead of the remote command", () => {
    expect(args.indexOf("vps.example.com")).toBeLessThan(args.indexOf("REMOTE_CMD"));
  });
});
