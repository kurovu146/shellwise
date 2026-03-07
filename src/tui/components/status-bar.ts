import { color } from "../theme";

export function renderStatusBar(resultCount: number, width: number): string {
  const left = `${color.dim} ${resultCount} result${resultCount !== 1 ? "s" : ""}`;
  const right = `Tab/S-Tab:navigate  Enter:select  Esc:cancel ${color.reset}`;
  const rightClean = `Tab/S-Tab:navigate  Enter:select  Esc:cancel `;
  const padding = Math.max(0, width - ` ${resultCount} results`.length - rightClean.length);

  return `${left}${" ".repeat(padding)}${right}`;
}
