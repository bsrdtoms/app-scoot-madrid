import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const db = new Database(join(__dirname, 'scootmap.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    name          TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    scooter_id   TEXT    NOT NULL,
    operator     TEXT    NOT NULL,
    model        TEXT,
    lat          REAL,
    lng          REAL,
    status       TEXT    NOT NULL DEFAULT 'pending',
    created_at   INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS linked_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    operator     TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'unlinked',
    note         TEXT,
    token        TEXT,
    operator_uid TEXT,
    created_at   INTEGER NOT NULL,
    UNIQUE (user_id, operator),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    scooter_id TEXT    NOT NULL,
    operator   TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, scooter_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_reservations_user ON reservations(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS user_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    last_ping  INTEGER NOT NULL,
    duration   INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id, started_at DESC);
`);

// Migrations for existing databases
for (const col of ['token TEXT', 'operator_uid TEXT']) {
  try { db.exec(`ALTER TABLE linked_accounts ADD COLUMN ${col}`); } catch {}
}
