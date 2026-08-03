/**
 * A stand-in daemon for the zsh integration tests, run as its own process.
 *
 * It has to be a separate process: the tests drive zsh with `Bun.spawnSync`,
 * which blocks the event loop, so a listener living in the test process would
 * never get a chance to answer and every request would time out.
 *
 * Usage: bun fake-daemon.ts <socket> <request-log> <base64-reply> [delay-ms]
 * Each request line is appended to the log as JSON, so tabs survive.
 *
 * `delay-ms` stands in for network latency: an ssh-forwarded socket answers a
 * whole round trip later than a local one.
 */
import { appendFileSync } from "fs";
import type { Socket } from "bun";

const [socketPath, logPath, replyB64, delayArg] = process.argv.slice(2);
const reply = Buffer.from(replyB64, "base64").toString();
const delayMs = Number(delayArg ?? 0);

Bun.listen({
  unix: socketPath,
  socket: {
    data(socket: Socket, data: Buffer) {
      for (const line of data.toString().split("\n")) {
        if (!line.trim()) continue;
        appendFileSync(logPath, JSON.stringify(line) + "\n");
        if (delayMs > 0) {
          setTimeout(() => {
            try {
              socket.write(reply);
            } catch {}
          }, delayMs);
        } else {
          socket.write(reply);
        }
      }
    },
  },
});

// Never outlive the test run, even if the test crashes before killing us.
setTimeout(() => process.exit(0), 30_000);
