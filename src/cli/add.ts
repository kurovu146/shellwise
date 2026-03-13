import { insertCommand } from "../db/queries";
import { getHostname } from "../utils/platform";

interface AddOptions {
  command: string;
  cwd?: string;
  exitCode?: number;
  duration?: number;
  session?: string;
  shell?: string;
}

export function runAdd(opts: AddOptions): void {
  const cmd = opts.command.trim();

  // Skip empty or very short commands
  if (!cmd || cmd.length < 2) return;

  // Skip commands starting with space (convention)
  if (opts.command.startsWith(" ")) return;

  // Only save successful commands (exit code 0)
  if (opts.exitCode !== undefined && opts.exitCode !== 0) return;

  // Skip shellwise's own commands
  const baseCmd = cmd.split(/\s+/)[0];
  if (baseCmd === "shellwise" || baseCmd === "sw") return;

  insertCommand({
    command: cmd,
    cwd: opts.cwd,
    exit_code: opts.exitCode,
    duration_ms: opts.duration,
    hostname: getHostname(),
    session_id: opts.session,
    shell: opts.shell,
  });
}
