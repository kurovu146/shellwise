import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { endpointPaths, getSocketPath, getPidPath } from "../../src/daemon/protocol";
import { isCompiled } from "../../src/utils/self";

describe("daemon endpoint paths", () => {
  test("POSIX keeps the uid-based /tmp path the shell scripts hardcode", () => {
    expect(endpointPaths({ platform: "linux", uid: 501, pid: 4242, username: "kuro", tmpdir: "/var/tmp" })).toEqual({
      socket: "/tmp/shellwise-501.sock",
      pid: "/tmp/shellwise-501.pid",
    });
  });

  test("Windows is stable across processes: named after the user, not the pid", () => {
    const a = endpointPaths({ platform: "win32", pid: 1, username: "Admin", tmpdir: "C:\\Users\\Admin\\AppData\\Local\\Temp" });
    const b = endpointPaths({ platform: "win32", pid: 2, username: "Admin", tmpdir: "C:\\Users\\Admin\\AppData\\Local\\Temp" });
    expect(a).toEqual(b);
    expect(a.socket).toBe(join("C:\\Users\\Admin\\AppData\\Local\\Temp", "shellwise-Admin.sock"));
    expect(a.pid).toBe(join("C:\\Users\\Admin\\AppData\\Local\\Temp", "shellwise-Admin.pid"));
  });

  test("Windows usernames are reduced to filename-safe characters", () => {
    const p = endpointPaths({ platform: "win32", pid: 1, username: "Vũ Đức Tuấn", tmpdir: "C:\\T" });
    expect(p.socket).toMatch(/shellwise-[A-Za-z0-9_-]+\.sock$/);
  });
});

describe("endpoint override", () => {
  const saved = { daemon: process.env.SHELLWISE_DAEMON_SOCKET, shell: process.env.SHELLWISE_SOCKET };
  afterEach(() => {
    for (const [k, v] of [["SHELLWISE_DAEMON_SOCKET", saved.daemon], ["SHELLWISE_SOCKET", saved.shell]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("SHELLWISE_DAEMON_SOCKET sets the socket and swaps .sock for .pid", () => {
    process.env.SHELLWISE_DAEMON_SOCKET = "/tmp/sw-abc/t.sock";
    expect(getSocketPath()).toBe("/tmp/sw-abc/t.sock");
    expect(getPidPath()).toBe("/tmp/sw-abc/t.pid");
  });

  test("only a literal trailing .sock is replaced", () => {
    process.env.SHELLWISE_DAEMON_SOCKET = "/tmp/sw-abc/sock";
    expect(getPidPath()).toBe("/tmp/sw-abc/sock.pid");
  });

  test("SHELLWISE_SOCKET (the shell integrations' variable, set by `sw ssh`) is ignored", () => {
    delete process.env.SHELLWISE_DAEMON_SOCKET;
    const before = getSocketPath();
    process.env.SHELLWISE_SOCKET = "/tmp/sw-remote-abc.sock";
    expect(getSocketPath()).toBe(before);
    expect(getPidPath()).not.toContain("sw-remote-abc");
  });
});

describe("isCompiled", () => {
  test("recognises compiled entry points on POSIX and Windows", () => {
    expect(isCompiled("/$bunfs/root/sw")).toBe(true);
    expect(isCompiled("B:/~BUN/root/shellwise.exe")).toBe(true);
    expect(isCompiled("B:\\~BUN\\root\\shellwise.exe")).toBe(true);
  });

  test("treats real script paths as script mode", () => {
    expect(isCompiled("C:\\shellwise\\src\\index.ts")).toBe(false);
    expect(isCompiled("/Users/k/shellwise/src/index.ts")).toBe(false);
  });
});
