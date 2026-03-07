import { Database } from "bun:sqlite";
import { getDbPath } from "../utils/paths";
import { runMigrations } from "./schema";

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;

  const dbPath = getDbPath();
  db = new Database(dbPath, { create: true });

  // Performance: WAL mode for concurrent read/write
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  runMigrations(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
