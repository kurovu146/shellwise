import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { insertCommand } from "../db/queries";
import { getHostname } from "../utils/platform";

export function runImport(shell?: string): void {
  const home = homedir();
  let imported = 0;

  if (!shell || shell === "zsh") {
    const zshPath = join(home, ".zsh_history");
    if (existsSync(zshPath)) {
      imported += importZshHistory(zshPath);
    }
  }

  if (!shell || shell === "bash") {
    const bashPath = join(home, ".bash_history");
    if (existsSync(bashPath)) {
      imported += importBashHistory(bashPath);
    }
  }

  console.log(`Imported ${imported} commands.`);
}

function importZshHistory(path: string): number {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  let count = 0;
  const hostname = getHostname();

  for (const line of lines) {
    // zsh extended format: : timestamp:0;command
    const extMatch = line.match(/^: (\d+):\d+;(.+)$/);
    if (extMatch) {
      const cmd = extMatch[2].trim();
      if (cmd && cmd.length >= 2) {
        insertCommand({
          command: cmd,
          hostname,
          shell: "zsh",
        });
        count++;
      }
      continue;
    }

    // Plain format
    const cmd = line.trim();
    if (cmd && cmd.length >= 2 && !cmd.startsWith("#")) {
      insertCommand({ command: cmd, hostname, shell: "zsh" });
      count++;
    }
  }

  return count;
}

function importBashHistory(path: string): number {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  let count = 0;
  const hostname = getHostname();

  for (const line of lines) {
    const cmd = line.trim();
    if (cmd && cmd.length >= 2 && !cmd.startsWith("#")) {
      insertCommand({ command: cmd, hostname, shell: "bash" });
      count++;
    }
  }

  return count;
}
