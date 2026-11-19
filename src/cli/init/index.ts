import { generateZshScript, type InitOptions } from "./zsh";
import { generateBashScript } from "./bash";
import { generateFishScript } from "./fish";
import { generatePowerShellScript } from "./powershell";
import { getSocketPath } from "../../daemon/protocol";
import { getDataDir } from "../../utils/paths";

export { generateZshScript, generateBashScript, generateFishScript, generatePowerShellScript };
export type { InitOptions };

export function runInit(shell: string, binaryPath: string, opts: InitOptions = {}): void {
  switch (shell) {
    case "zsh":
      process.stdout.write(generateZshScript(binaryPath, opts));
      break;
    case "bash":
      if (opts.remote) {
        console.error("Remote mode supports zsh only (bash integration needs the binary).");
        process.exit(1);
      }
      process.stdout.write(generateBashScript(binaryPath));
      break;
    case "fish":
      if (opts.remote) {
        console.error("Remote mode supports zsh only (fish integration needs the binary).");
        process.exit(1);
      }
      process.stdout.write(generateFishScript(binaryPath));
      break;
    case "powershell":
    case "pwsh":
      if (opts.remote) {
        console.error("Remote mode supports zsh only (PowerShell integration needs the binary).");
        process.exit(1);
      }
      process.stdout.write(generatePowerShellScript(binaryPath, { socketPath: getSocketPath(), dataDir: getDataDir() }));
      break;
    default:
      console.error(`Unsupported shell: ${shell}. Supported: zsh, bash, fish, powershell`);
      process.exit(1);
  }
}
