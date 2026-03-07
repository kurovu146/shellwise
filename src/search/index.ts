import { fuzzyMatch } from "./fuzzy";
import { rankResults, type ScoredResult } from "./scorer";
import { searchCommands, type CommandStats } from "../db/queries";
import { getDb } from "../db/connection";

export type { ScoredResult } from "./scorer";

export interface SearchInput {
  query: string;
  cwd?: string;
  limit?: number;
}

export function search(input: SearchInput): ScoredResult[] {
  const limit = input.limit ?? 50;

  // Phase 1: Pre-filter from DB (SQL LIKE)
  const dbResults = searchCommands({
    query: input.query || undefined,
    limit: 200,
  });

  if (dbResults.length === 0) return [];

  // Phase 2: Fuzzy match & score
  if (!input.query) {
    // No query = return by frecency
    return dbResults.slice(0, limit).map((stat) => ({
      command: stat.command,
      commandHash: stat.command_hash,
      frequency: stat.frequency,
      lastUsedAt: stat.last_used_at,
      fuzzyScore: 1,
      frecencyScore: stat.frecency_score,
      finalScore: stat.frecency_score,
      matchPositions: [],
    }));
  }

  const matches = [];
  for (const stat of dbResults) {
    const match = fuzzyMatch(input.query, stat.command);
    if (match) matches.push(match);
  }

  // Get CWD-related commands for bonus scoring
  let cwdCommands: Set<string> | undefined;
  if (input.cwd) {
    const db = getDb();
    const rows = db
      .query<{ command_hash: string }, [string]>(
        "SELECT DISTINCT command_hash FROM commands WHERE cwd = ?"
      )
      .all(input.cwd);
    cwdCommands = new Set(rows.map((r) => r.command_hash));
  }

  return rankResults(matches, dbResults, input.cwd, cwdCommands).slice(0, limit);
}
