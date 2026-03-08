import type Database from 'better-sqlite3';

/** Persists the hub message ID in SQLite for cross-instance continuity. */
export class HubStore {
  constructor(private readonly db: Database.Database) {}

  /** Save the current hub message ID. */
  save(messageId: number): void {
    this.db.prepare(
      'INSERT INTO hub_state (id, hub_message_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hub_message_id = excluded.hub_message_id'
    ).run(messageId);
  }

  /** Load the persisted hub message ID, or null if none saved. */
  load(): number | null {
    const row = this.db.prepare('SELECT hub_message_id FROM hub_state WHERE id = 1').get() as { hub_message_id: number } | undefined;
    return row?.hub_message_id ?? null;
  }

  /** Clear the persisted hub message ID. */
  clear(): void {
    this.db.prepare('DELETE FROM hub_state WHERE id = 1').run();
  }
}
