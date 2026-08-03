import { generateZshScript, type InitOptions } from "./zsh";
import { generateBashScript } from "./bash";

export { generateZshScript, generateBashScript };
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
    default:
      console.error(`Unsupported shell: ${shell}. Supported: zsh, bash`);
      process.exit(1);
  }
}
