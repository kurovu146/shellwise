/**
 * Read-only proxy in front of the daemon socket.
 *
 * `sw ssh` forwards a socket to a remote host, which means anything able to
 * reach that socket over there — including root on the remote box — speaks the
 * daemon protocol. The daemon itself has no auth: its whole security model is
 * "only a same-uid process on this machine can open the socket", and forwarding
 * breaks exactly that assumption.
 *
 * So the remote end never touches the daemon directly. It talks to this proxy,
 * which forwards reads and drops writes:
 *   SUGGEST → forwarded
 *   PING    → answered here
 *   ADD     → swallowed (poisoned history would suggest commands you then run)
 *   STOP    → always refused, even with writes enabled
 */

import { parseRequest } from "./protocol";
import { unlinkSync, existsSync, chmodSync } from "fs";
import { connect } from "net";
import type { Socket } from "bun";

export interface FilterResult {
  forward: boolean;
  /** Reply to send back without involving the daemon. */
  response?: string;
}

export function filterRequest(line: string, allowWrite: boolean): FilterResult {
  const req = parseRequest(line);
  if (!req) return { forward: false, response: "\n" };

  switch (req.type) {
    case "SUGGEST":
      return { forward: true };

    case "PING":
      return { forward: false, response: "PONG\n\n" };

    case "ADD":
      // Reply "OK" rather than an error: the remote shell treats a failed ADD
      // as a dead connection and reconnects on every prompt.
      return allowWrite ? { forward: true } : { forward: false, response: "OK\n\n" };

    case "STOP":
      // A remote host must never be able to shut down the local daemon.
      return { forward: false, response: "\n" };
  }
}

export interface ProxyOptions {
  /** Socket the proxy listens on (the one handed to `ssh -R`). */
  listenPath: string;
  /** The real daemon socket. */
  upstreamPath: string;
  /** Let the remote host write to local history. Off by default. */
  allowWrite?: boolean;
}

export interface Proxy {
  stop(): void;
}

const MAX_LINE_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 1000;

/** One request to the daemon, one reply back. */
function askUpstream(upstreamPath: string, message: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(upstreamPath);
    let data = "";
    const done = (reply: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => done("\n"), UPSTREAM_TIMEOUT_MS);

    socket.on("connect", () => socket.write(message));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n\n")) done(data);
    });
    socket.on("error", () => done("\n"));
  });
}

export function startProxy(opts: ProxyOptions): Proxy {
  const { listenPath, upstreamPath, allowWrite = false } = opts;

  if (existsSync(listenPath)) {
    try {
      unlinkSync(listenPath);
    } catch {}
  }

  const server = Bun.listen({
    unix: listenPath,
    socket: {
      open(socket: Socket) {
        (socket as unknown as { buf: string }).buf = "";
      },
      data(socket: Socket, data: Buffer) {
        const state = socket as unknown as { buf: string };
        let buf = state.buf + data.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;

          const verdict = filterRequest(line, allowWrite);
          if (!verdict.forward) {
            socket.write(verdict.response ?? "\n");
            continue;
          }
          askUpstream(upstreamPath, line + "\n").then((reply) => {
            try {
              socket.write(reply);
            } catch {}
          });
        }
        state.buf = buf.length > MAX_LINE_BYTES ? "" : buf;
      },
      close() {},
      error() {},
    },
  });

  // Same 0600 posture as the daemon socket.
  try {
    chmodSync(listenPath, 0o600);
  } catch {}

  return {
    stop() {
      server.stop(true);
      if (existsSync(listenPath)) {
        try {
          unlinkSync(listenPath);
        } catch {}
      }
    },
  };
}
