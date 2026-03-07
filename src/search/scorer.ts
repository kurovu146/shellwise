import type { FuzzyMatch } from "./fuzzy";
import type { CommandStats } from "../db/queries";

export interface ScoredResult {
  command: string;
  commandHash: string;
  frequency: number;
  lastUsedAt: number;
  fuzzyScore: number;
  frecencyScore: number;
  finalScore: number;
  matchPositions: number[];
}

export interface ScoreWeights {
  fuzzy: number;
  frecency: number;
  cwdBonus: number;
}

const DEFAULT_WEIGHTS: ScoreWeights = {
  fuzzy: 0.6,
  frecency: 0.3,
  cwdBonus: 0.1,
};

export function rankResults(
  matches: FuzzyMatch[],
  stats: CommandStats[],
  currentCwd?: string,
  cwdCommands?: Set<string>,
  weights: ScoreWeights = DEFAULT_WEIGHTS
): ScoredResult[] {
  const statsMap = new Map<string, CommandStats>();
  for (const s of stats) {
    statsMap.set(s.command, s);
  }

  const results: ScoredResult[] = [];
  const maxFrecency = stats.reduce((max, s) => Math.max(max, s.frecency_score), 1);

  for (const match of matches) {
    const stat = statsMap.get(match.text);
    if (!stat) continue;

    const normalizedFrecency = stat.frecency_score / maxFrecency;

    // CWD bonus
    const cwd = currentCwd && cwdCommands?.has(stat.command_hash) ? 1 : 0;

    const finalScore =
      match.score * weights.fuzzy +
      normalizedFrecency * weights.frecency +
      cwd * weights.cwdBonus;

    results.push({
      command: match.text,
      commandHash: stat.command_hash,
      frequency: stat.frequency,
      lastUsedAt: stat.last_used_at,
      fuzzyScore: match.score,
      frecencyScore: stat.frecency_score,
      finalScore,
      matchPositions: match.positions,
    });
  }

  results.sort((a, b) => b.finalScore - a.finalScore);
  return results;
}
