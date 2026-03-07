import type { Database } from "bun:sqlite";

const MIGRATIONS = [
  {
    version: 1,
    up(db: Database) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS commands (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          command TEXT NOT NULL,
          command_hash TEXT NOT NULL,
          cwd TEXT,
          exit_code INTEGER,
          duration_ms INTEGER,
          hostname TEXT,
          session_id TEXT,
          shell TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS command_stats (
          command_hash TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          frequency INTEGER DEFAULT 1,
          last_used_at INTEGER NOT NULL,
          frecency_score REAL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_commands_hash ON commands(command_hash);
        CREATE INDEX IF NOT EXISTS idx_commands_created ON commands(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_commands_cwd ON commands(cwd);
        CREATE INDEX IF NOT EXISTS idx_stats_frecency ON command_stats(frecency_score DESC);
      `);
    },
  },
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db.query<{ version: number }, []>(
    "SELECT MAX(version) as version FROM schema_version"
  ).get();
  const currentVersion = row?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.transaction(() => {
        migration.up(db);
        db.run("INSERT INTO schema_version (version) VALUES (?)", [migration.version]);
      })();
    }
  }
}
