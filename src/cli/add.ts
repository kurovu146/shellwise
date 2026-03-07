import { insertCommand } from "../db/queries";
import { getHostname } from "../utils/platform";
import { IGNORED_COMMANDS } from "../utils/constants";

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

  // Skip empty, very short, or ignored commands
  if (!cmd || cmd.length < 2) return;

  // Skip commands starting with space (convention)
  if (opts.command.startsWith(" ")) return;

  // Only save successful commands (exit code 0)
  if (opts.exitCode !== undefined && opts.exitCode !== 0) return;

  // Skip ignored commands (only the base command, not arguments)
  const baseCmd = cmd.split(/\s+/)[0];
  if (IGNORED_COMMANDS.has(baseCmd)) return;

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
