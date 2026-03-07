import type Database from 'better-sqlite3';

/** Persists user settings (key-value) in SQLite. */
export class SettingsStore {
  constructor(private readonly db: Database.Database) {}

  /** Get a boolean setting by key. Returns false if not found. */
  get(key: string): boolean {
    const row = this.db.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).get(key) as { value: string } | undefined;
    return row?.value === 'true';
  }

  /** Set a boolean setting by key. */
  set(key: string, value: boolean): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value ? 'true' : 'false', now);
  }

  /** Get a numeric setting by key. Returns defaultValue if not found or not a number. */
  getNumber(key: string, defaultValue: number): number {
    const row = this.db.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).get(key) as { value: string } | undefined;
    if (!row) return defaultValue;
    const parsed = parseInt(row.value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }

  /** Set a numeric setting by key. */
  setNumber(key: string, value: number): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, String(value), now);
  }

  /** Get the last-updated timestamp for a setting, or null if not found. */
  getUpdatedAt(key: string): string | null {
    const row = this.db.prepare(
      'SELECT updated_at FROM settings WHERE key = ?'
    ).get(key) as { updated_at: string } | undefined;
    return row?.updated_at ?? null;
  }
}
