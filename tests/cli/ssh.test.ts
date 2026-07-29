import { describe, test, expect } from "bun:test";
import { buildRemoteZshrc, buildRemoteCommand, buildSshArgs } from "../../src/cli/ssh";

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
  const zshAvailable = Bun.spawnSync(["sh", "-c", "command -v zsh"]).exitCode === 0;

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

  test.if(zshAvailable)("falls back to a normal shell when no decoder works", async () => {
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
