import { getSocketPath } from "./protocol";
import { existsSync } from "fs";
import { connect } from "net";

/**
 * Send request to daemon via Unix socket.
 * Returns response lines or null if daemon unavailable.
 */
export function daemonRequest(message: string, timeoutMs: number = 500): Promise<string[] | null> {
  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) return Promise.resolve(null);

  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(message);
    });

    socket.on("data", (chunk) => {
      data += chunk.toString();
      // Response ends with double newline
      if (data.includes("\n\n")) {
        clearTimeout(timer);
        socket.destroy();
        const lines = data.trim().split("\n").filter(Boolean);
        resolve(lines);
      }
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
