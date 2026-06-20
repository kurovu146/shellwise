import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { FRECENCY_EXPR } from "../../src/db/frecency";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE command_stats (
      command_hash TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      frequency INTEGER DEFAULT 1,
      last_used_at INTEGER NOT NULL,
      frecency_score REAL DEFAULT 0
    );
  `);
  return db;
}

function seed(
  db: Database,
  rows: { cmd: string; freq: number; ageMs: number }[]
): void {
  const now = Date.now();
  const stmt = db.prepare(
    "INSERT INTO command_stats (command_hash, command, frequency, last_used_at) VALUES (?, ?, ?, ?)"
  );
  for (const r of rows) {
    stmt.run(r.cmd, r.cmd, r.freq, now - r.ageMs);
  }
}

function rankedOrder(db: Database): string[] {
  return db
    .query<{ command: string }, []>(
      `SELECT command FROM command_stats ORDER BY ${FRECENCY_EXPR} DESC, command ASC`
    )
    .all()
    .map((r) => r.command);
}

test("same frequency: more recent command ranks higher", () => {
  const db = makeDb();
  seed(db, [
    { cmd: "git stash", freq: 10, ageMs: 40 * DAY }, // tier 0.5 -> 5
    { cmd: "git status", freq: 10, ageMs: 30 * 60_000 }, // tier 4.0 -> 40
  ]);
  expect(rankedOrder(db)).toEqual(["git status", "git stash"]);
});

test("recency overturns raw frequency", () => {
  const db = makeDb();
  // Old behaviour (frequency x constant 4) would rank "old script" first (20x4=80 > 2x4=8).
  // Dynamic frecency: deploy=2x4.0=8 beats old=20x0.25=5.
  seed(db, [
    { cmd: "old script", freq: 20, ageMs: 200 * DAY }, // tier 0.25 -> 5
    { cmd: "deploy prod", freq: 2, ageMs: 5 * 60_000 }, // tier 4.0 -> 8
  ]);
  expect(rankedOrder(db)[0]).toBe("deploy prod");
});

test("same recency tier: higher frequency ranks higher", () => {
  const db = makeDb();
  seed(db, [
    { cmd: "b cmd", freq: 2, ageMs: 60_000 },
    { cmd: "a cmd", freq: 5, ageMs: 60_000 },
  ]);
  expect(rankedOrder(db)).toEqual(["a cmd", "b cmd"]);
});
