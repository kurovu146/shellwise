#!/usr/bin/env bun

import { runAdd } from "./cli/add";
import { runSearch, pickCommand } from "./cli/search";
import { runSuggest } from "./cli/suggest";
import { runInit } from "./cli/init";
import { runSsh } from "./cli/ssh";
import { runImport } from "./cli/import";
import { runStats } from "./cli/stats";
import { runPrune } from "./cli/prune";
import { deleteCommand } from "./db/queries";
import { closeDb } from "./db/connection";
import { checkForUpdate } from "./utils/update-check";
import { startServer, isDaemonRunning, isDaemonLive, getDaemonInfo } from "./daemon/server";
import { daemonRequest, probeDaemon } from "./daemon/client";
import { selfCommand } from "./utils/self";
import { getDataDir } from "./utils/paths";
import { resolve as resolvePath } from "path";

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1];
      i++;
    }
  }
  return flags;
}

/**
 * `add --from-env`: the same fields as the flags, read from SW_ADD_* env vars.
 * PowerShell records commands this way, since a Windows command line would
 * lose or mangle quotes inside the command.
 */
function addFlagsFromEnv(): Record<string, string> {
  const vars: Record<string, string> = {
    command: "SW_ADD_COMMAND",
    cwd: "SW_ADD_CWD",
    "exit-code": "SW_ADD_EXIT_CODE",
    duration: "SW_ADD_DURATION",
    session: "SW_ADD_SESSION",
    shell: "SW_ADD_SHELL",
  };
  const flags: Record<string, string> = {};
  for (const [flag, name] of Object.entries(vars)) {
    const value = process.env[name];
    if (value) flags[flag] = value;
  }
  return flags;
}

function printHelp(): void {
  console.log(`shellwise - Smart command history with fuzzy search

Usage: shellwise <command> [options]  (or: sw <command>)

Commands:
  search [--query <text>]     Interactive fuzzy search (Ctrl+R)
  suggest --query <text>      Get top suggestion (used by shell hook)
  add <cmd>                   Save a command to history
  delete <cmd>                Delete a command from history
  init <zsh|bash|fish|powershell>  Output shell integration script
  ssh [ssh options] <host>    SSH with suggestions on the remote host
  import [zsh|bash|fish|powershell]  Import existing shell history
  stats                       Show usage statistics
  prune --days <n>            Remove entries older than n days
  daemon start|stop|status    Manage background daemon (faster suggest)
  version                     Show current version

Setup:
  Add to ~/.zshrc:   eval "$(shellwise init zsh)"
  Add to ~/.bashrc:  eval "$(shellwise init bash)"
  Add to fish config: shellwise init fish | source
  Add to $PROFILE:   shellwise init powershell | Out-String | Invoke-Expression

Features:
  - Auto-save: commands are recorded automatically
  - Auto-suggest: inline dropdown as you type (Tab/S-Tab to navigate)
  - Ctrl+R: full interactive fuzzy search
  - Daemon mode: ~1-3ms suggest via Unix socket
  - sw ssh: same dropdown on a remote host, nothing installed there`);
}

async function main(): Promise<void> {
  try {
    switch (command) {
      case "search": {
        const flags = parseFlags(args.slice(1));
        // PowerShell passes the query in SW_QUERY: a Windows command line
        // would mangle its quotes.
        runSearch(flags.query ?? process.env.SW_QUERY ?? "");
        break;
      }

      case "suggest": {
        const flags = parseFlags(args.slice(1));
        if (!flags.query) break;
        const limit = flags.limit ? parseInt(flags.limit) : 5;

        // Try daemon first (fast path ~1-3ms)
        const result = await daemonRequest(`SUGGEST\t${flags.query}\t${limit}\n`);
        if (result) {
          process.stdout.write(result.join("\n"));
        } else {
          // Fallback: direct DB query (~20ms)
          runSuggest(flags.query, limit);
        }
        break;
      }

      case "add": {
        const flags = args[1] === "--from-env" ? addFlagsFromEnv() : parseFlags(args.slice(1));
        const addCmd = flags.command || args.slice(1).filter(a => !a.startsWith("--")).join(" ");
        if (!addCmd) {
          console.error("Usage: shellwise add <cmd>");
          process.exit(1);
        }

        // Try daemon first
        // Strip tabs from command to avoid breaking protocol delimiter
        const safeCommand = addCmd.replace(/\t/g, " ");
        const addMsg = `ADD\t${safeCommand}\t${flags.cwd || ""}\t${flags["exit-code"] || "0"}\t${flags.duration || "0"}\t${flags.session || ""}\t${flags.shell || ""}\n`;
        const addResult = await daemonRequest(addMsg);
        if (!addResult) {
          // Fallback: direct
          runAdd({
            command: addCmd,
            cwd: flags.cwd,
            exitCode: flags["exit-code"] ? parseInt(flags["exit-code"]) : undefined,
            duration: flags.duration ? parseInt(flags.duration) : undefined,
            session: flags.session,
            shell: flags.shell,
          });
        }
        break;
      }

      case "init": {
        const shell = args[1];
        if (!shell) {
          console.error("Usage: shellwise init <zsh|bash|fish|powershell> [--remote]");
          process.exit(1);
        }
        runInit(shell, "shellwise", { remote: args.includes("--remote") });
        break;
      }

      case "ssh": {
        const sshArgs = args.slice(1).filter((a) => a !== "--save-history");
        const code = await runSsh(sshArgs, { allowWrite: args.includes("--save-history") });
        if (code !== 0) process.exitCode = code;
        break;
      }

      case "import": {
        runImport(args[1]);
        break;
      }

      case "stats": {
        runStats();
        break;
      }

      case "prune": {
        const flags = parseFlags(args.slice(1));
        const days = parseInt(flags.days || "90");
        runPrune(days);
        break;
      }

      case "daemon": {
        const sub = args[1];
        switch (sub) {
          case "start": {
            if (await isDaemonLive()) {
              console.log("Daemon already running.");
              return;
            }
            // The daemon runs in another directory (below), so relative paths
            // given to this process must reach it already resolved, or it
            // would use a second DB / config / socket under its own cwd.
            const daemonEnv: Record<string, string | undefined> = { ...process.env };
            for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "SHELLWISE_DAEMON_SOCKET"]) {
              const value = process.env[name];
              if (value) daemonEnv[name] = resolvePath(value);
            }
            // Keep every handle we were handed (a caller's output pipe among
            // them) out of the long-lived daemon. Imported here: it loads
            // bun:ffi, which no other command needs.
            if (process.platform === "win32") {
              const { stopHandleInheritance } = await import("./utils/win-handles");
              stopHandleInheritance();
            }
            // Fork to background — respawn THIS executable, never a PATH
            // lookup (which could resolve to a different install).
            const proc = Bun.spawn([...selfCommand(), "daemon", "_run"], {
              // A neutral working directory: the daemon outlives its starter,
              // and on Windows a process's cwd cannot be renamed or removed.
              cwd: getDataDir(),
              env: daemonEnv,
              stdio: ["ignore", "ignore", "ignore"],
              windowsHide: true,
              // @ts-ignore - Bun supports detached
              detached: true,
            });
            proc.unref();
            // Poll until a daemon answers (up to 3s): a cold start on Windows
            // is slower than a fixed 200ms guess. It may be another start's:
            // of daemons started at once only one keeps running. A socket
            // file alone proves nothing, it may be a dead daemon's.
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
              if (isDaemonRunning() && (await probeDaemon()) !== "unreachable") break;
              await new Promise((r) => setTimeout(r, 50));
            }
            if (isDaemonRunning()) {
              const info = getDaemonInfo();
              console.log(`Daemon started (pid: ${info?.pid})`);
            } else {
              console.error("Failed to start daemon.");
              process.exit(1);
            }
            break;
          }
          case "_run":
            // Internal: actual daemon process
            await startServer();
            break;
          case "stop": {
            if (!(await isDaemonLive())) {
              console.log("Daemon not running.");
              return;
            }
            await daemonRequest("STOP\n");
            // The daemon exits ~50ms after replying; wait for it so `stop` means
            // stopped (a following `status` or restart must not race it).
            const stopDeadline = Date.now() + 3000;
            while (isDaemonRunning() && Date.now() < stopDeadline) {
              await new Promise((r) => setTimeout(r, 50));
            }
            if (isDaemonRunning()) {
              console.error(`Failed to stop daemon (pid: ${getDaemonInfo()?.pid}).`);
              process.exit(1);
            }
            console.log("Daemon stopped.");
            break;
          }
          case "status": {
            if (await isDaemonLive()) {
              const info = getDaemonInfo();
              console.log(`Daemon running (pid: ${info?.pid})`);
            } else {
              console.log("Daemon not running.");
            }
            break;
          }
          default:
            console.error("Usage: shellwise daemon start|stop|status");
            process.exit(1);
        }
        break;
      }

      case "delete": {
        const delQuery = args.slice(1).join(" ");
        const delCmd = pickCommand(delQuery);
        if (delCmd) {
          const deleted = deleteCommand(delCmd);
          if (deleted) {
            console.log(`Deleted: ${delCmd}`);
          } else {
            console.log("Command not found in history.");
          }
        }
        break;
      }

      case "version":
      case "--version":
      case "-v": {
        const pkg = require("../package.json");
        console.log(pkg.version);
        break;
      }

      case "help":
      case "--help":
      case "-h":
      case undefined:
        printHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    if (command !== "daemon") closeDb();

    // Check for updates on interactive commands (cached, max once per day)
    const silentCommands = new Set(["suggest", "add", "search", "init", "daemon", "_run"]);
    if (command && !silentCommands.has(command)) {
      const pkg = require("../package.json");
      await checkForUpdate(pkg.version);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
