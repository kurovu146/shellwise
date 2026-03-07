import { color, icon } from "../theme";
import { truncate } from "../renderer";
import type { ScoredResult } from "../../search";

export interface ResultListState {
  results: ScoredResult[];
  selectedIndex: number;
  scrollOffset: number;
  visibleCount: number;
}

export function renderResultList(state: ResultListState, width: number): string[] {
  const lines: string[] = [];
  const { results, selectedIndex, scrollOffset, visibleCount } = state;

  if (results.length === 0) {
    lines.push(`${color.dim}  No matches found${color.reset}`);
    return lines;
  }

  const end = Math.min(scrollOffset + visibleCount, results.length);

  for (let i = scrollOffset; i < end; i++) {
    const result = results[i];
    const isSelected = i === selectedIndex;
    const prefix = isSelected
      ? `${color.cyan}${color.bold}${icon.selected} ${color.reset}`
      : "  ";

    const timeStr = formatTimeAgo(result.lastUsedAt);
    const freqStr = result.frequency > 1 ? `${color.dim}(${result.frequency}x)${color.reset} ` : "";

    const metaLen = timeStr.length + (result.frequency > 1 ? `(${result.frequency}x) `.length : 0) + 4;
    const maxCmdWidth = width - metaLen - 2;

    let cmdDisplay: string;
    if (isSelected) {
      cmdDisplay = highlightMatches(
        truncate(result.command, maxCmdWidth),
        result.matchPositions,
        `${color.white}${color.bold}`,
        `${color.yellow}${color.bold}${color.underline}`
      );
    } else {
      cmdDisplay = highlightMatches(
        truncate(result.command, maxCmdWidth),
        result.matchPositions,
        color.white,
        `${color.cyan}`
      );
    }

    const rightSide = `${freqStr}${color.dim}${timeStr}${color.reset}`;
    const padding = Math.max(0, width - truncate(result.command, maxCmdWidth).length - metaLen - 2);

    lines.push(`${prefix}${cmdDisplay}${" ".repeat(padding)}${rightSide}`);
  }

  return lines;
}

function highlightMatches(
  text: string,
  positions: number[],
  normalStyle: string,
  matchStyle: string
): string {
  if (positions.length === 0) return `${normalStyle}${text}${color.reset}`;

  const posSet = new Set(positions);
  let result = "";
  let inMatch = false;

  for (let i = 0; i < text.length; i++) {
    if (posSet.has(i)) {
      if (!inMatch) {
        result += matchStyle;
        inMatch = true;
      }
    } else {
      if (inMatch) {
        result += color.reset + normalStyle;
        inMatch = false;
      }
    }
    result += text[i];
  }

  return `${normalStyle}${result}${color.reset}`;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (weeks < 52) return `${weeks}w ago`;
  return `${Math.floor(days / 365)}y ago`;
}
