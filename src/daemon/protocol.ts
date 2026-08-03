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
  /** Client speaks v2: it wants `<source>\t<command>` lines back. */
  tagged: boolean;
}

export type SuggestSource = "history" | "common";

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
      return `SUGGEST\t${req.query}\t${req.limit}${req.tagged ? "\tv2" : ""}\n`;
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
      return {
        type: "SUGGEST",
        query: parts[1] || "",
        limit: parseInt(parts[2]) || 5,
        // A shell from an older install sends no marker at all; it must keep
        // getting the bare-command format it knows how to parse.
        tagged: parts[3] === "v2",
      };
    case "ADD": {
      // Distinguish a real 0 from an unparseable/missing field (a desynced
      // line must not masquerade as a successful exit code 0).
      const exit = parseInt(parts[3]);
      const dur = parseInt(parts[4]);
      return {
        type: "ADD",
        command: parts[1] || "",
        cwd: parts[2] || "",
        exitCode: Number.isNaN(exit) ? -1 : exit,
        duration: Number.isNaN(dur) ? 0 : dur,
        session: parts[5] || "",
        shell: parts[6] || "",
      };
    }
    case "STOP":
      return { type: "STOP" };
    case "PING":
      return { type: "PING" };
    default:
      return null;
  }
}

/**
 * Wire format of a SUGGEST reply. The source goes *before* the command so the
 * client can split on the first tab and keep the rest of the line verbatim.
 */
export function formatSuggestResponse(
  results: { command: string; source: SuggestSource }[],
  tagged: boolean
): string {
  if (results.length === 0) return "\n";
  const lines = results.map((r) => (tagged ? `${r.source}\t${r.command}` : r.command));
  return lines.join("\n") + "\n\n";
}

export function getSocketPath(): string {
  const uid = process.getuid?.() ?? process.pid;
  return `/tmp/shellwise-${uid}.sock`;
}

export function getPidPath(): string {
  const uid = process.getuid?.() ?? process.pid;
  return `/tmp/shellwise-${uid}.pid`;
}
