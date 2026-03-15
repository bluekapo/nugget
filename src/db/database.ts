import Database from 'better-sqlite3';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    // Verify WAL actually works on this filesystem (mmap fails on some Docker bind mounts)
    db.exec('CREATE TABLE IF NOT EXISTS _wal_test (id INTEGER PRIMARY KEY)');
    db.exec('DROP TABLE _wal_test');
  } catch {
    // WAL unsupported (e.g. Windows bind mount) — nuke the DB and start fresh with DELETE mode
    db.close();
    try { unlinkSync(path); } catch { /* ignore */ }
    try { unlinkSync(path + '-wal'); } catch { /* ignore */ }
    try { unlinkSync(path + '-shm'); } catch { /* ignore */ }
    const cleanDb = new Database(path);
    cleanDb.pragma('journal_mode = DELETE');
    cleanDb.pragma('foreign_keys = ON');
    return cleanDb;
  }
  db.pragma('foreign_keys = ON');

  return db;
}
