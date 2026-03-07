#!/usr/bin/env bun

import { runAdd } from "./cli/add";
import { runSearch } from "./cli/search";
import { runSuggest } from "./cli/suggest";
import { runInit } from "./cli/init";
import { runImport } from "./cli/import";
import { runStats } from "./cli/stats";
import { runPrune } from "./cli/prune";
import { closeDb } from "./db/connection";
import { startServer, isDaemonRunning, getDaemonInfo } from "./daemon/server";
import { daemonRequest } from "./daemon/client";

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

function printHelp(): void {
  console.log(`shellwise - Smart command history with fuzzy search

Usage: shellwise <command> [options]  (or: sw <command>)

Commands:
  search [--query <text>]     Interactive fuzzy search (Ctrl+R)
  suggest --query <text>      Get top suggestion (used by shell hook)
  add --command <cmd>         Save a command to history
  init <zsh|bash>             Output shell integration script
  import [zsh|bash]           Import existing shell history
  stats                       Show usage statistics
  prune --days <n>            Remove entries older than n days
  daemon start|stop|status    Manage background daemon (faster suggest)

Setup:
  Add to ~/.zshrc:   eval "$(shellwise init zsh)"
  Add to ~/.bashrc:  eval "$(shellwise init bash)"

Features:
  - Auto-save: commands are recorded automatically
  - Auto-suggest: inline dropdown as you type (Tab/S-Tab to navigate)
  - Ctrl+R: full interactive fuzzy search
  - Daemon mode: ~1-3ms suggest via Unix socket`);
}

async function main(): Promise<void> {
  try {
    switch (command) {
      case "search": {
        const flags = parseFlags(args.slice(1));
        await runSearch(flags.query || "");
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
        const flags = parseFlags(args.slice(1));
        if (!flags.command) {
          console.error("Usage: shellwise add --command <cmd>");
          process.exit(1);
        }

        // Try daemon first
        // Strip tabs from command to avoid breaking protocol delimiter
        const safeCommand = flags.command.replace(/\t/g, " ");
        const addMsg = `ADD\t${safeCommand}\t${flags.cwd || ""}\t${flags["exit-code"] || "0"}\t${flags.duration || "0"}\t${flags.session || ""}\t${flags.shell || ""}\n`;
        const addResult = await daemonRequest(addMsg);
        if (!addResult) {
          // Fallback: direct
          runAdd({
            command: flags.command,
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
          console.error("Usage: shellwise init <zsh|bash>");
          process.exit(1);
        }
        runInit(shell, "shellwise");
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
            if (isDaemonRunning()) {
              console.log("Daemon already running.");
              return;
            }
            // Fork to background
            const proc = Bun.spawn(["shellwise", "daemon", "_run"], {
              stdio: ["ignore", "ignore", "ignore"],
              // @ts-ignore - Bun supports detached
              detached: true,
            });
            proc.unref();
            // Wait a bit and verify
            await new Promise((r) => setTimeout(r, 200));
            if (isDaemonRunning()) {
              const info = getDaemonInfo();
              console.log(`Daemon started (pid: ${info?.pid}, port: ${info?.port})`);
            } else {
              console.error("Failed to start daemon.");
              process.exit(1);
            }
            break;
          }
          case "_run":
            // Internal: actual daemon process
            startServer();
            break;
          case "stop": {
            if (!isDaemonRunning()) {
              console.log("Daemon not running.");
              return;
            }
            await daemonRequest("STOP\n");
            console.log("Daemon stopped.");
            break;
          }
          case "status": {
            if (isDaemonRunning()) {
              const info = getDaemonInfo();
              console.log(`Daemon running (pid: ${info?.pid}, port: ${info?.port})`);
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
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
