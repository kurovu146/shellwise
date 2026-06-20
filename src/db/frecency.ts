/**
 * Frecency = frequency × recency-weight, computed AT QUERY TIME.
 *
 * Recency must decay as time passes, so the weight is derived from the age
 * of `last_used_at` on every read instead of being frozen into a stored
 * column at write time. This single SQL expression is the source of truth
 * shared by the daemon (inline suggest), the daemon-less fallback, and the
 * Ctrl+R full search, so all three rank results identically.
 *
 * Requires `frequency` and `last_used_at` (epoch ms) columns in scope.
 */
export const FRECENCY_EXPR = `
  frequency * (
    CASE
      WHEN (strftime('%s','now') * 1000 - last_used_at) < 3600000    THEN 4.0
      WHEN (strftime('%s','now') * 1000 - last_used_at) < 86400000   THEN 2.0
      WHEN (strftime('%s','now') * 1000 - last_used_at) < 604800000  THEN 1.5
      WHEN (strftime('%s','now') * 1000 - last_used_at) < 2592000000 THEN 1.0
      WHEN (strftime('%s','now') * 1000 - last_used_at) < 7776000000 THEN 0.5
      ELSE 0.25
    END
  )
`;
