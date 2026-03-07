import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { MessageStore, type MessageRow } from '../../src/db/messages.js';

describe('Migration v2 - messages table', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates messages table with correct columns', () => {
    const columns = db.pragma('table_info(messages)') as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;

    const columnNames = columns.map((c) => c.name);
    assert.ok(columnNames.includes('id'), 'should have id column');
    assert.ok(columnNames.includes('session_name'), 'should have session_name column');
    assert.ok(columnNames.includes('telegram_message_id'), 'should have telegram_message_id column');
    assert.ok(columnNames.includes('content'), 'should have content column');
    assert.ok(columnNames.includes('sequence_num'), 'should have sequence_num column');
    assert.ok(columnNames.includes('status'), 'should have status column');
    assert.ok(columnNames.includes('created_at'), 'should have created_at column');
  });
});

describe('MessageStore', () => {
  let db: Database.Database;
  let store: MessageStore;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    store = new MessageStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('save() inserts a message and getBySession() retrieves it', () => {
    store.save('sess-1', 100, 'hello world', 1);
    const rows = store.getBySession('sess-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_name, 'sess-1');
    assert.equal(rows[0].telegram_message_id, 100);
    assert.equal(rows[0].content, 'hello world');
    assert.equal(rows[0].sequence_num, 1);
    assert.equal(rows[0].status, 'active');
  });

  it('getBySession() returns messages ordered by sequence_num ASC', () => {
    store.save('sess-1', 100, 'third', 3);
    store.save('sess-1', 101, 'first', 1);
    store.save('sess-1', 102, 'second', 2);

    const rows = store.getBySession('sess-1');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].content, 'first');
    assert.equal(rows[1].content, 'second');
    assert.equal(rows[2].content, 'third');
  });

  it('getBySession() filters by session_name', () => {
    store.save('sess-1', 100, 'for sess-1', 1);
    store.save('sess-2', 200, 'for sess-2', 1);

    const rows1 = store.getBySession('sess-1');
    assert.equal(rows1.length, 1);
    assert.equal(rows1[0].content, 'for sess-1');

    const rows2 = store.getBySession('sess-2');
    assert.equal(rows2.length, 1);
    assert.equal(rows2[0].content, 'for sess-2');
  });

  it('deleteBySession() removes all messages for a session', () => {
    store.save('sess-1', 100, 'msg1', 1);
    store.save('sess-1', 101, 'msg2', 2);
    store.save('sess-2', 200, 'other', 1);

    store.deleteBySession('sess-1');

    const rows1 = store.getBySession('sess-1');
    assert.equal(rows1.length, 0);

    // Other session unaffected
    const rows2 = store.getBySession('sess-2');
    assert.equal(rows2.length, 1);
  });

  it('updateStatus() changes status for all messages in a session', () => {
    store.save('sess-1', 100, 'msg1', 1);
    store.save('sess-1', 101, 'msg2', 2);

    store.updateStatus('sess-1', 'persisted');

    // Read raw rows to check status (getBySession filters by status)
    const rawRows = db.prepare(
      `SELECT * FROM messages WHERE session_name = ? ORDER BY sequence_num`
    ).all('sess-1') as MessageRow[];

    assert.equal(rawRows.length, 2);
    assert.equal(rawRows[0].status, 'persisted');
    assert.equal(rawRows[1].status, 'persisted');
  });

  it('getBySession() only returns active or persisted messages, not archived', () => {
    store.save('sess-1', 100, 'active-msg', 1);
    store.save('sess-1', 101, 'archived-msg', 2);

    // Archive the second message
    db.prepare(
      `UPDATE messages SET status = 'archived' WHERE telegram_message_id = 101`
    ).run();

    const rows = store.getBySession('sess-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, 'active-msg');
  });
});
