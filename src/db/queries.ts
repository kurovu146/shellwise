import { getDb } from "./connection";
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
  const db = getDb();
  const hash = hashCommand(input.command);
  const now = Date.now();

  db.transaction(() => {
    db.run(
      `INSERT INTO commands (command, command_hash, cwd, exit_code, duration_ms, hostname, session_id, shell, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.command,
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

    // Upsert command_stats
    db.run(
      `INSERT INTO command_stats (command_hash, command, frequency, last_used_at, frecency_score)
       VALUES (?, ?, 1, ?, 4.0)
       ON CONFLICT(command_hash) DO UPDATE SET
         frequency = frequency + 1,
         last_used_at = ?,
         frecency_score = (frequency + 1) * ?`,
      [hash, input.command.trim(), now, now, calculateRecencyWeight(now)]
    );
  })();
}

function calculateRecencyWeight(lastUsedAt: number): number {
  const age = Date.now() - lastUsedAt;
  const hour = 3600_000;
  if (age < hour) return 4.0;
  if (age < 24 * hour) return 2.0;
  if (age < 7 * 24 * hour) return 1.5;
  if (age < 30 * 24 * hour) return 1.0;
  if (age < 90 * 24 * hour) return 0.5;
  return 0.25;
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
      `SELECT command_hash, command, frequency, last_used_at, frecency_score
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

  const result = db.run("DELETE FROM commands WHERE created_at < ?", [cutoff]);

  // Cleanup orphaned stats
  db.run(
    `DELETE FROM command_stats WHERE command_hash NOT IN (SELECT DISTINCT command_hash FROM commands)`
  );

  return result.changes;
}

export function refreshAllFrecency(): void {
  const db = getDb();
  const now = Date.now();
  const stats = db
    .query<{ command_hash: string; frequency: number; last_used_at: number }, []>(
      "SELECT command_hash, frequency, last_used_at FROM command_stats"
    )
    .all();

  const update = db.prepare(
    "UPDATE command_stats SET frecency_score = ? WHERE command_hash = ?"
  );

  db.transaction(() => {
    for (const s of stats) {
      const weight = calculateRecencyWeight(s.last_used_at);
      update.run(s.frequency * weight, s.command_hash);
    }
  })();
}
