import { describe, test, expect, afterEach } from "bun:test";
import { filterRequest, startProxy } from "../../src/daemon/proxy";
import { unlinkSync, existsSync } from "fs";
import { connect } from "net";
import type { Socket } from "bun";

describe("filterRequest — read-only (default)", () => {
  test("forwards SUGGEST to the daemon", () => {
    expect(filterRequest("SUGGEST\tgit st\t5", false)).toEqual({ forward: true });
  });

  test("answers PING locally without touching the daemon", () => {
    expect(filterRequest("PING", false)).toEqual({ forward: false, response: "PONG\n\n" });
  });

  test("swallows ADD so the remote host cannot poison local history", () => {
    const result = filterRequest("ADD\trm -rf /\t/tmp\t0\t1\tsess\tzsh", false);
    expect(result.forward).toBe(false);
    // Reply as success: the remote shell must not spin on retries.
    expect(result.response).toBe("OK\n\n");
  });

  test("refuses STOP so the remote host cannot kill the local daemon", () => {
    const result = filterRequest("STOP", false);
    expect(result.forward).toBe(false);
    expect(result.response).not.toContain("BYE");
  });

  test("drops unparseable lines", () => {
    expect(filterRequest("NONSENSE\tfoo", false).forward).toBe(false);
  });
});

describe("filterRequest — write enabled", () => {
  test("forwards ADD when history saving is allowed", () => {
    expect(filterRequest("ADD\tgit push\t/tmp\t0\t1\tsess\tzsh", true)).toEqual({ forward: true });
  });

  test("still refuses STOP", () => {
    expect(filterRequest("STOP", true).forward).toBe(false);
  });
});

// ─── End-to-end over real Unix sockets ──────────────────────

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function startFakeDaemon(path: string): { received: string[] } {
  const received: string[] = [];
  if (existsSync(path)) unlinkSync(path);
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket: Socket, data: Buffer) {
        for (const line of data.toString().split("\n")) {
          if (!line.trim()) continue;
          received.push(line);
          socket.write("upstream-reply\n\n");
        }
      },
    },
  });
  cleanup.push(() => {
    server.stop(true);
    if (existsSync(path)) unlinkSync(path);
  });
  return { received };
}

function ask(socketPath: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout waiting for proxy reply"));
    }, 2000);
    socket.on("connect", () => socket.write(message));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      // Protocol: an empty line terminates the response — which for an empty
      // reply means the whole response is just "\n".
      if (data.includes("\n\n") || data.startsWith("\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("startProxy", () => {
  const upstream = `/tmp/sw-test-upstream-${process.pid}.sock`;
  const listen = `/tmp/sw-test-proxy-${process.pid}.sock`;

  test("passes SUGGEST through to the daemon and returns its reply", async () => {
    const daemon = startFakeDaemon(upstream);
    const proxy = startProxy({ listenPath: listen, upstreamPath: upstream });
    cleanup.push(() => proxy.stop());

    const reply = await ask(listen, "SUGGEST\tgit\t5\n");

    expect(daemon.received).toEqual(["SUGGEST\tgit\t5"]);
    expect(reply).toBe("upstream-reply\n\n");
  });

  test("never lets ADD reach the daemon in read-only mode", async () => {
    const daemon = startFakeDaemon(upstream);
    const proxy = startProxy({ listenPath: listen, upstreamPath: upstream });
    cleanup.push(() => proxy.stop());

    const reply = await ask(listen, "ADD\tevil\t/tmp\t0\t1\ts\tzsh\n");

    expect(daemon.received).toEqual([]);
    expect(reply).toBe("OK\n\n");
  });

  test("lets ADD through when writes are enabled", async () => {
    const daemon = startFakeDaemon(upstream);
    const proxy = startProxy({ listenPath: listen, upstreamPath: upstream, allowWrite: true });
    cleanup.push(() => proxy.stop());

    await ask(listen, "ADD\tgit push\t/tmp\t0\t1\ts\tzsh\n");

    expect(daemon.received).toEqual(["ADD\tgit push\t/tmp\t0\t1\ts\tzsh"]);
  });

  test("still refuses STOP when writes are enabled", async () => {
    const daemon = startFakeDaemon(upstream);
    const proxy = startProxy({ listenPath: listen, upstreamPath: upstream, allowWrite: true });
    cleanup.push(() => proxy.stop());

    await ask(listen, "STOP\n");

    expect(daemon.received).toEqual([]);
  });

  test("handles two requests on one connection", async () => {
    const daemon = startFakeDaemon(upstream);
    const proxy = startProxy({ listenPath: listen, upstreamPath: upstream });
    cleanup.push(() => proxy.stop());

    await ask(listen, "SUGGEST\tgit\t5\n");
    await ask(listen, "SUGGEST\tls\t5\n");

    expect(daemon.received).toEqual(["SUGGEST\tgit\t5", "SUGGEST\tls\t5"]);
  });

  test("removes its socket file on stop", () => {
    startFakeDaemon(upstream);
    const proxy = startProxy({ listenPath: listen, upstreamPath: upstream });
    expect(existsSync(listen)).toBe(true);
    proxy.stop();
    expect(existsSync(listen)).toBe(false);
  });
});
