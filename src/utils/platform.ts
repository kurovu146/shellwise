import { basename } from "path";

export function detectShell(): "zsh" | "bash" | "unknown" {
  const shell = process.env.SHELL || "";
  const name = basename(shell);
  if (name === "zsh") return "zsh";
  if (name === "bash") return "bash";
  return "unknown";
}

export function getHostname(): string {
  return process.env.HOSTNAME || require("os").hostname();
}
