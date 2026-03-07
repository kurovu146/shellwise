import { color, icon } from "../theme";
import { truncate } from "../renderer";

export interface SearchBoxState {
  query: string;
  cursorPos: number;
}

export function renderSearchBox(state: SearchBoxState, width: number): string {
  const prefix = `${color.cyan}${color.bold}${icon.prompt} ${color.reset}`;
  const prefixLen = 2; // "> "
  const maxQueryWidth = width - prefixLen - 1;
  const displayQuery = truncate(state.query, maxQueryWidth);

  return `${prefix}${displayQuery}`;
}

export function getSearchBoxCursorCol(state: SearchBoxState): number {
  return state.cursorPos + 3; // "> " + 1-based column
}
