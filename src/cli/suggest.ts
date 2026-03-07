import { getDb } from "../db/connection";
import { getCommonSuggestions } from "../data/common-commands";

/**
 * Suggest: 5 history + 5 common commands, deduplicated.
 */
export function runSuggest(query: string, limit: number = 5): void {
  if (!query || query.length < 2) return;

  const db = getDb();
  const historyResults: string[] = [];

  // Escape LIKE wildcards in user input
  const escapedQuery = query.replace(/[%_\\]/g, "\\$&");

  // History: prefix matches
  const prefixes = db
    .query<{ command: string }, [string, number]>(
      `SELECT command FROM command_stats
       WHERE command LIKE ? || '%' ESCAPE '\\'
       ORDER BY frecency_score DESC
       LIMIT ?`
    )
    .all(escapedQuery, limit);

  for (const r of prefixes) {
    if (r.command !== query) historyResults.push(r.command);
  }

  // History: contains matches (fill remaining)
  if (historyResults.length < limit) {
    const remaining = limit - historyResults.length;
    const resultSet = new Set(historyResults);

    const contains = db
      .query<{ command: string }, [string, string, number]>(
        `SELECT command FROM command_stats
         WHERE command LIKE '%' || ? || '%' ESCAPE '\\' AND command != ?
         ORDER BY frecency_score DESC
         LIMIT ?`
      )
      .all(escapedQuery, query, remaining + historyResults.length);

    for (const r of contains) {
      if (!resultSet.has(r.command) && r.command !== query) {
        historyResults.push(r.command);
        if (historyResults.length >= limit) break;
      }
    }
  }

  // Common commands (deduplicated)
  const seen = new Set(historyResults);
  const commonResults = getCommonSuggestions(query, 10)
    .filter((cmd) => !seen.has(cmd) && cmd !== query)
    .slice(0, 5);

  const merged = [...historyResults, ...commonResults];

  if (merged.length > 0) {
    process.stdout.write(merged.join("\n"));
  }
}
