/**
 * `sw ssh <host>` — inline suggestions inside an SSH session, with nothing
 * installed on the remote host.
 *
 * How it fits together:
 *
 *   remote zsh ──▶ /tmp/sw-<rand>.sock  (created by sshd)
 *                        │  ssh -R
 *                        ▼
 *   local proxy ──▶ shellwise daemon ──▶ history.db
 *
 * The remote side needs no binary: the integration script is pure zsh talking
 * to a Unix socket, shipped over as a throwaway ZDOTDIR. History and the daemon
 * never leave this machine, and the proxy drops writes (see daemon/proxy.ts).
 */

import { randomBytes } from "crypto";
import { generateZshScript } from "./init";
import { startProxy } from "../daemon/proxy";
import { getSocketPath } from "../daemon/protocol";
import { isDaemonRunning } from "../daemon/server";

/** The `.zshrc` placed in the remote throwaway ZDOTDIR. */
export function buildRemoteZshrc(integration: string): string {
  return `# shellwise remote session (temporary — removed when you log out)
# Restore ZDOTDIR first: the user's own config may rely on it.
ZDOTDIR=$HOME
[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"

${integration}`;
}

export interface RemoteCommandOptions {
  zshrc: string;
  socketPath: string;
}

/**
 * POSIX sh run by the remote host. The config travels as base64 so quotes,
 * newlines and shell metacharacters in it cannot escape the single-quoted
 * argument.
 */
export function buildRemoteCommand(opts: RemoteCommandOptions): string {
  const payload = Buffer.from(opts.zshrc).toString("base64");
  const sock = opts.socketPath;

  return [
    // No zsh over there? Don't strand the user in a broken login.
    `if ! command -v zsh >/dev/null 2>&1; then`,
    `  echo "shellwise: zsh not found on this host — starting your normal shell." >&2;`,
    `  echo "shellwise: suggestions need zsh there; install zsh on the host to enable them." >&2;`,
    `  rm -f ${sock};`,
    `  exec "\${SHELL:-/bin/sh}" -l;`,
    `fi;`,
    `d=$(mktemp -d 2>/dev/null || mktemp -d -t shellwise) || exec "\${SHELL:-/bin/sh}" -l;`,
    `printf %s '${payload}' > "$d/.payload";`,
    // Always decode from stdin: BSD/macOS base64 rejects a positional input
    // file, and would leave an empty .zshrc behind (the redirect creates it
    // before the command runs). openssl needs -A for one long line.
    `base64 -d < "$d/.payload" > "$d/.zshrc" 2>/dev/null ||`,
    `  base64 -D < "$d/.payload" > "$d/.zshrc" 2>/dev/null ||`,
    `  openssl base64 -d -A -in "$d/.payload" -out "$d/.zshrc" 2>/dev/null;`,
    `rm -f "$d/.payload";`,
    // Empty config means the decode failed on every path. Starting zsh now
    // would strip the user of their own setup — hand them a normal shell.
    `if [ ! -s "$d/.zshrc" ]; then`,
    `  echo "shellwise: could not stage the remote config — starting your normal shell" >&2;`,
    `  rm -rf "$d"; rm -f ${sock};`,
    `  exec "\${SHELL:-/bin/sh}" -l;`,
    `fi;`,
    `SHELLWISE_SOCKET=${sock} ZDOTDIR="$d" zsh -i;`,
    `__sw_status=$?;`,
    `rm -rf "$d"; rm -f ${sock};`,
    `exit $__sw_status`,
  ].join(" ");
}

export interface SshArgsOptions {
  userArgs: string[];
  localSocket: string;
  remoteSocket: string;
  remoteCommand: string;
}

export function buildSshArgs(opts: SshArgsOptions): string[] {
  return [
    "-t",
    "-o",
    "StreamLocalBindUnlink=yes",
    "-R",
    `${opts.remoteSocket}:${opts.localSocket}`,
    ...opts.userArgs,
    opts.remoteCommand,
  ];
}

export interface RunSshOptions {
  /** Let the remote host write into local history. Off by default. */
  allowWrite?: boolean;
}

export async function runSsh(userArgs: string[], opts: RunSshOptions = {}): Promise<number> {
  if (userArgs.length === 0) {
    console.error(`Usage: shellwise ssh [--save-history] [ssh options] <host>

Runs ssh with shellwise suggestions active on the remote host.
Nothing is installed there: the remote zsh talks to your local daemon
through a forwarded socket, and your history never leaves this machine.

  --save-history   also record commands you run remotely (off by default,
                   so a compromised host cannot plant commands in your history)`);
    return 1;
  }

  if (!isDaemonRunning()) {
    console.error("shellwise: daemon is not running — start it with 'shellwise daemon start'");
    return 1;
  }

  const token = randomBytes(8).toString("hex");
  const localSocket = `/tmp/shellwise-ssh-${process.getuid?.() ?? process.pid}-${token}.sock`;
  const remoteSocket = `/tmp/shellwise-ssh-${token}.sock`;

  const proxy = startProxy({
    listenPath: localSocket,
    upstreamPath: getSocketPath(),
    allowWrite: opts.allowWrite === true,
  });

  try {
    const remoteCommand = buildRemoteCommand({
      zshrc: buildRemoteZshrc(generateZshScript("shellwise", { remote: true })),
      socketPath: remoteSocket,
    });

    const proc = Bun.spawn(
      ["ssh", ...buildSshArgs({ userArgs, localSocket, remoteSocket, remoteCommand })],
      { stdio: ["inherit", "inherit", "inherit"] }
    );
    return await proc.exited;
  } finally {
    proxy.stop();
  }
}
