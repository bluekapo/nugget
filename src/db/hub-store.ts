import type Database from 'better-sqlite3';
import { logDebug } from '../logging/logger.js';

/** Persists the hub message ID in SQLite for cross-instance continuity. */
export class HubStore {
  constructor(private readonly db: Database.Database) {}

  /** Save the current hub message ID. */
  save(messageId: number): void {
    logDebug(`[hub-store] Saving hub message ID: ${messageId}`);
    this.db.prepare(
      'INSERT INTO hub_state (id, hub_message_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hub_message_id = excluded.hub_message_id'
    ).run(messageId);
  }

  /** Load the persisted hub message ID, or null if none saved. */
  load(): number | null {
    const row = this.db.prepare('SELECT hub_message_id FROM hub_state WHERE id = 1').get() as { hub_message_id: number } | undefined;
    const result = row?.hub_message_id ?? null;
    logDebug(`[hub-store] Loaded hub message ID: ${result}`);
    return result;
  }

  /** Clear the persisted hub message ID. */
  clear(): void {
    logDebug('[hub-store] Clearing hub message ID');
    this.db.prepare('DELETE FROM hub_state WHERE id = 1').run();
  }
}
