import { describe, test, expect } from "bun:test";
import { join } from "path";
import { endpointPaths } from "../../src/daemon/protocol";
import { isCompiled } from "../../src/utils/self";

describe("daemon endpoint paths", () => {
  test("POSIX keeps the uid-based /tmp path the shell scripts hardcode", () => {
    expect(endpointPaths({ platform: "linux", uid: 501, pid: 4242, username: "kuro", tmpdir: "/var/tmp" })).toEqual({
      socket: "/tmp/shellwise-501.sock",
      pid: "/tmp/shellwise-501.pid",
    });
  });

  test("Windows is stable across processes: named after the user, not the pid", () => {
    const a = endpointPaths({ platform: "win32", pid: 1, username: "Admin", tmpdir: "C:\Users\Admin\AppData\Local\Temp" });
    const b = endpointPaths({ platform: "win32", pid: 2, username: "Admin", tmpdir: "C:\Users\Admin\AppData\Local\Temp" });
    expect(a).toEqual(b);
    expect(a.socket).toBe(join("C:\Users\Admin\AppData\Local\Temp", "shellwise-Admin.sock"));
    expect(a.pid).toBe(join("C:\Users\Admin\AppData\Local\Temp", "shellwise-Admin.pid"));
  });

  test("Windows usernames are reduced to filename-safe characters", () => {
    const p = endpointPaths({ platform: "win32", pid: 1, username: "Vũ Đức Tuấn", tmpdir: "C:\T" });
    expect(p.socket).toMatch(/shellwise-[A-Za-z0-9_-]+\.sock$/);
  });
});

describe("isCompiled", () => {
  test("recognises compiled entry points on POSIX and Windows", () => {
    expect(isCompiled("/$bunfs/root/sw")).toBe(true);
    expect(isCompiled("B:/~BUN/root/shellwise.exe")).toBe(true);
  });

  test("treats real script paths as script mode", () => {
    expect(isCompiled("C:\shellwise\src\index.ts")).toBe(false);
    expect(isCompiled("/Users/k/shellwise/src/index.ts")).toBe(false);
  });
});
