export interface FuzzyMatch {
  text: string;
  score: number;
  positions: number[];
}

/**
 * Fuzzy match algorithm — returns match score and character positions.
 * Prioritizes: sequential matches > word boundary > any match
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { text: target, score: 1, positions: [] };

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  // Quick check: all query chars exist in target?
  let checkIdx = 0;
  for (let i = 0; i < queryLower.length; i++) {
    const found = targetLower.indexOf(queryLower[i], checkIdx);
    if (found === -1) return null;
    checkIdx = found + 1;
  }

  // Score matching with position tracking
  const positions: number[] = [];
  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -2;

  for (let i = 0; i < targetLower.length && queryIdx < queryLower.length; i++) {
    if (targetLower[i] === queryLower[queryIdx]) {
      positions.push(i);

      // Consecutive match bonus
      if (i === prevMatchIdx + 1) {
        score += 3;
      }

      // Word boundary bonus (start, after space/slash/dash/dot)
      if (i === 0 || " /\\-_.".includes(target[i - 1])) {
        score += 2;
      }

      // Exact case match bonus
      if (target[i] === query[queryIdx]) {
        score += 0.5;
      }

      score += 1; // base score per match
      prevMatchIdx = i;
      queryIdx++;
    }
  }

  if (queryIdx < queryLower.length) return null;

  // Normalize score (0-1 range)
  const maxPossible = queryLower.length * 6.5; // max per char: 3+2+0.5+1
  const normalized = Math.min(score / maxPossible, 1);

  // Bonus for shorter targets (prefer exact-ish matches)
  const lengthBonus = query.length / target.length;
  const finalScore = normalized * 0.8 + lengthBonus * 0.2;

  return { text: target, score: finalScore, positions };
}

export function fuzzyFilter(query: string, items: string[]): FuzzyMatch[] {
  const results: FuzzyMatch[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, item);
    if (match) results.push(match);
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
