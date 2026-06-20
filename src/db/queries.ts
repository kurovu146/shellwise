import { getDb } from "./connection";
import { FRECENCY_EXPR } from "./frecency";
import { createHash } from "crypto";

export interface CommandRecord {
  id: number;
  command: string;
  command_hash: string;
  cwd: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  hostname: string | null;
  session_id: string | null;
  shell: string | null;
  created_at: number;
}

export interface CommandStats {
  command_hash: string;
  command: string;
  frequency: number;
  last_used_at: number;
  frecency_score: number;
}

export interface InsertCommandInput {
  command: string;
  cwd?: string;
  exit_code?: number;
  duration_ms?: number;
  hostname?: string;
  session_id?: string;
  shell?: string;
}

export function hashCommand(command: string): string {
  return createHash("sha256").update(command.trim()).digest("hex").slice(0, 16);
}

export function insertCommand(input: InsertCommandInput): void {
  // Defense in depth: strip control chars (incl. NUL/tab/newline) and cap
  // length before persisting, so a garbage/poisoned ADD can't store binary
  // blobs or megabyte lines that later corrupt TUI rendering.
  const command = input.command.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (command.length < 2 || command.length > 8192) return;

  const db = getDb();
  const hash = hashCommand(command);
  const now = Date.now();

  db.transaction(() => {
    db.run(
      `INSERT INTO commands (command, command_hash, cwd, exit_code, duration_ms, hostname, session_id, shell, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        command,
        hash,
        input.cwd ?? null,
        input.exit_code ?? null,
        input.duration_ms ?? null,
        input.hostname ?? null,
        input.session_id ?? null,
        input.shell ?? null,
        now,
      ]
    );

    // Upsert command_stats. frecency_score is no longer used for ranking
    // (recency is computed at query time via FRECENCY_EXPR); we keep the
    // column populated with the raw frequency for debugging/back-compat.
    db.run(
      `INSERT INTO command_stats (command_hash, command, frequency, last_used_at, frecency_score)
       VALUES (?, ?, 1, ?, 1)
       ON CONFLICT(command_hash) DO UPDATE SET
         frequency = frequency + 1,
         last_used_at = ?,
         frecency_score = frequency + 1`,
      [hash, command, now, now]
    );
  })();
}

export interface SearchOptions {
  query?: string;
  cwd?: string;
  limit?: number;
  exitCode?: number;
}

export function searchCommands(opts: SearchOptions): CommandStats[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.query) {
    conditions.push("cs.command LIKE ? ESCAPE '\\'");
    // Escape LIKE wildcards in user input
    const escaped = opts.query.replace(/[%_\\]/g, "\\$&");
    params.push(`%${escaped}%`);
  }

  if (opts.cwd) {
    conditions.push(
      "cs.command_hash IN (SELECT DISTINCT command_hash FROM commands WHERE cwd = ?)"
    );
    params.push(opts.cwd);
  }

  if (opts.exitCode !== undefined) {
    conditions.push(
      "cs.command_hash IN (SELECT DISTINCT command_hash FROM commands WHERE exit_code = ?)"
    );
    params.push(opts.exitCode);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;

  const rows = db
    .query<CommandStats, (string | number)[]>(
      `SELECT command_hash, command, frequency, last_used_at, ${FRECENCY_EXPR} AS frecency_score
       FROM command_stats cs
       ${where}
       ORDER BY frecency_score DESC
       LIMIT ?`
    )
    .all(...params, limit);

  return rows;
}

export function getUniqueCommandCount(): number {
  const db = getDb();
  const row = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM command_stats"
  ).get();
  return row?.count ?? 0;
}

export function getTotalCommandCount(): number {
  const db = getDb();
  const row = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM commands"
  ).get();
  return row?.count ?? 0;
}

export function pruneOlderThan(days: number): number {
  const db = getDb();
  const cutoff = Date.now() - days * 24 * 3600_000;

  const result = db.run(
    `DELETE FROM commands WHERE command_hash IN (
       SELECT command_hash FROM command_stats WHERE last_used_at < ?
     )`,
    [cutoff]
  );

  // Cleanup orphaned stats
  db.run(
    `DELETE FROM command_stats WHERE command_hash NOT IN (SELECT DISTINCT command_hash FROM commands)`
  );

  return result.changes;
}

export function deleteCommand(command: string): boolean {
  const db = getDb();
  const hash = hashCommand(command);

  const result = db.run("DELETE FROM commands WHERE command_hash = ?", [hash]);
  db.run("DELETE FROM command_stats WHERE command_hash = ?", [hash]);

  return result.changes > 0;
}

export function getExistingHashes(): Set<string> {
  const db = getDb();
  const rows = db
    .query<{ command_hash: string }, []>(
      "SELECT command_hash FROM command_stats"
    )
    .all();
  return new Set(rows.map((r) => r.command_hash));
}
