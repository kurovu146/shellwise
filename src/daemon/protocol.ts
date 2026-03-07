/**
 * Simple text protocol over Unix socket.
 * Request:  COMMAND\targ1\targ2\n
 * Response: line1\nline2\n\n  (empty line = end)
 */

export type RequestType = "SUGGEST" | "ADD" | "STOP" | "PING";

export interface SuggestRequest {
  type: "SUGGEST";
  query: string;
  limit: number;
}

export interface AddRequest {
  type: "ADD";
  command: string;
  cwd: string;
  exitCode: number;
  duration: number;
  session: string;
  shell: string;
}

export interface StopRequest {
  type: "STOP";
}

export interface PingRequest {
  type: "PING";
}

export type Request = SuggestRequest | AddRequest | StopRequest | PingRequest;

export function serializeRequest(req: Request): string {
  switch (req.type) {
    case "SUGGEST":
      return `SUGGEST\t${req.query}\t${req.limit}\n`;
    case "ADD":
      return `ADD\t${req.command}\t${req.cwd}\t${req.exitCode}\t${req.duration}\t${req.session}\t${req.shell}\n`;
    case "STOP":
      return `STOP\n`;
    case "PING":
      return `PING\n`;
  }
}

export function parseRequest(raw: string): Request | null {
  const line = raw.trim();
  const parts = line.split("\t");
  const type = parts[0] as RequestType;

  switch (type) {
    case "SUGGEST":
      return { type: "SUGGEST", query: parts[1] || "", limit: parseInt(parts[2]) || 5 };
    case "ADD":
      return {
        type: "ADD",
        command: parts[1] || "",
        cwd: parts[2] || "",
        exitCode: parseInt(parts[3]) || 0,
        duration: parseInt(parts[4]) || 0,
        session: parts[5] || "",
        shell: parts[6] || "",
      };
    case "STOP":
      return { type: "STOP" };
    case "PING":
      return { type: "PING" };
    default:
      return null;
  }
}

export function getSocketPath(): string {
  const uid = process.getuid?.() ?? process.pid;
  return `/tmp/shellwise-${uid}.sock`;
}

/** TCP port = 19850 + (uid % 100) to avoid collisions */
export function getDaemonPort(): number {
  const uid = process.getuid?.() ?? 501;
  return 19850 + (uid % 100);
}

export function getPidPath(): string {
  const uid = process.getuid?.() ?? process.pid;
  return `/tmp/shellwise-${uid}.pid`;
}
