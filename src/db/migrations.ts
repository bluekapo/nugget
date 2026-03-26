import type Database from 'better-sqlite3';
import { logDebug, logInfo } from '../logging/logger.js';

interface Migration {
  version: number;
  up: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'starting',
        workspace TEXT NOT NULL,
        docker_sandbox_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_name TEXT NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        sequence_num INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_messages_session ON messages(session_name, status);
      CREATE INDEX idx_messages_session_seq ON messages(session_name, sequence_num);
    `,
  },
  {
    version: 3,
    up: `
      CREATE TABLE sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'starting',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO sessions_new (id, name, pid, status, created_at, updated_at)
        SELECT id, name, pid, status, created_at, updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `,
  },
  {
    version: 4,
    up: `
      CREATE TABLE hub_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        hub_message_id INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    up: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT 'true',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO settings (key, value) VALUES ('notifications', 'true');
    `,
  },
  {
    version: 6,
    up: `
      CREATE TABLE automations (
        id INTEGER PRIMARY KEY,
        worker_session TEXT NOT NULL,
        orchestrator_session TEXT NOT NULL,
        task_description TEXT NOT NULL,
        engine_state TEXT NOT NULL DEFAULT 'idle',
        cycle_count INTEGER NOT NULL DEFAULT 0,
        last_action TEXT,
        action_log_json TEXT NOT NULL DEFAULT '[]',
        start_time INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 7,
    up: `
      CREATE TABLE automation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orchestrator_session TEXT NOT NULL,
        worker_session TEXT NOT NULL,
        task_description TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        cycle_count INTEGER NOT NULL,
        outcome TEXT NOT NULL
      );
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  logDebug(`[migrations] Current schema version: ${currentVersion}, latest: ${migrations[migrations.length - 1]?.version ?? 0}`);

  let applied = 0;
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      logInfo(`[migrations] Applying migration v${migration.version}`);
      db.exec(migration.up);
      db.pragma(`user_version = ${migration.version}`);
      applied++;
    }
  }

  if (applied > 0) {
    logInfo(`[migrations] Applied ${applied} migration(s), now at v${db.pragma('user_version', { simple: true })}`);
  } else {
    logDebug('[migrations] Schema up to date, no migrations needed');
  }
}
