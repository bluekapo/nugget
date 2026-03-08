import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { MessageStore } from '../../src/db/messages.js';
import { MessageTracker } from '../../src/telegram/messages.js';

/** Create a mock Telegram API with call tracking. */
function createMockApi() {
  let messageIdCounter = 100;
  const calls: { method: string; args: unknown[] }[] = [];

  return {
    api: {
      deleteMessages: mock.fn(async (_chatId: number, _messageIds: number[]) => {
        calls.push({ method: 'deleteMessages', args: [_chatId, _messageIds] });
        return true;
      }),
      sendMessage: mock.fn(async (_chatId: number, _text: string, _opts?: unknown) => {
        messageIdCounter++;
        calls.push({ method: 'sendMessage', args: [_chatId, _text, _opts] });
        return { message_id: messageIdCounter };
      }),
    },
    calls,
    getCounter: () => messageIdCounter,
  };
}

/** Create a mock output sink with getCurrentState(). */
function createMockOutputSink(state: { messageId: number; text: string } | null = null) {
  return {
    getCurrentState: mock.fn(() => state),
  };
}

describe('MessageTracker', () => {
  let db: Database.Database;
  let store: MessageStore;
  let mockApi: ReturnType<typeof createMockApi>;
  let tracker: MessageTracker;
  const CHAT_ID = 12345;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    store = new MessageStore(db);
    mockApi = createMockApi();
    tracker = new MessageTracker(mockApi.api, CHAT_ID, store);
  });

  afterEach(() => {
    db.close();
  });

  describe('track()', () => {
    it('adds a message ID to the session tracked list', () => {
      tracker.track('sess-a', 1, 'hello');
      // Verify by persisting -- if tracked, persistAndDelete will save it
      const sink = createMockOutputSink(null);
      // We'll verify via store after persistAndDelete
      return tracker.persistAndDelete('sess-a', sink).then(() => {
        // The message should have been saved to the store before deletion
        // Since deleteBySession is NOT called by persistAndDelete (only delete from Telegram),
        // we check that the store has the message
        // Actually, persistAndDelete clears in-memory IDs but saves to store first.
        // After persistAndDelete, the store should have the message.
        const rows = db.prepare('SELECT * FROM messages WHERE session_name = ?').all('sess-a') as Array<{ content: string }>;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].content, 'hello');
      });
    });

    it('keeps messages separate for different sessions', () => {
      tracker.track('sess-a', 1, 'msg-a');
      tracker.track('sess-b', 2, 'msg-b');

      const sink = createMockOutputSink(null);
      return tracker.persistAndDelete('sess-a', sink).then(() => {
        const rowsA = db.prepare('SELECT * FROM messages WHERE session_name = ?').all('sess-a') as Array<{ content: string }>;
        assert.equal(rowsA.length, 1);
        assert.equal(rowsA[0].content, 'msg-a');

        // sess-b should not have been persisted (we only persisted sess-a)
        const rowsB = db.prepare('SELECT * FROM messages WHERE session_name = ?').all('sess-b') as Array<{ content: string }>;
        assert.equal(rowsB.length, 0);
      });
    });
  });

  describe('persistAndDelete()', () => {
    it('saves tracked messages + current sink state to store, then calls deleteMessages', async () => {
      tracker.track('sess-a', 10, 'tracked msg');
      const sink = createMockOutputSink({ messageId: 20, text: 'current output' });

      await tracker.persistAndDelete('sess-a', sink);

      // Should have saved both tracked message and current sink message
      const rows = db.prepare('SELECT * FROM messages WHERE session_name = ? ORDER BY sequence_num').all('sess-a') as Array<{
        telegram_message_id: number;
        content: string;
        sequence_num: number;
      }>;
      assert.equal(rows.length, 2);
      assert.equal(rows[0].telegram_message_id, 10);
      assert.equal(rows[0].content, 'tracked msg');
      assert.equal(rows[1].telegram_message_id, 20);
      assert.equal(rows[1].content, 'current output');

      // Should have called deleteMessages with both IDs
      const deleteCalls = mockApi.calls.filter(c => c.method === 'deleteMessages');
      assert.equal(deleteCalls.length, 1);
      const deletedIds = deleteCalls[0].args[1] as number[];
      assert.ok(deletedIds.includes(10));
      assert.ok(deletedIds.includes(20));
    });

    it('chunks deleteMessages calls to 100 IDs max per API call', async () => {
      // Track 150 messages
      for (let i = 0; i < 150; i++) {
        tracker.track('sess-a', i + 1, `msg-${i}`);
      }
      const sink = createMockOutputSink(null);

      await tracker.persistAndDelete('sess-a', sink);

      const deleteCalls = mockApi.calls.filter(c => c.method === 'deleteMessages');
      assert.equal(deleteCalls.length, 2, 'Should chunk 150 IDs into 2 API calls');
      assert.equal((deleteCalls[0].args[1] as number[]).length, 100);
      assert.equal((deleteCalls[1].args[1] as number[]).length, 50);
    });

    it('logs error but does not throw if deleteMessages fails', async () => {
      tracker.track('sess-a', 10, 'msg');
      const sink = createMockOutputSink(null);

      // Make deleteMessages throw
      mockApi.api.deleteMessages = mock.fn(async () => {
        throw new Error('Telegram API error');
      });

      // Should not throw
      await tracker.persistAndDelete('sess-a', sink);

      // Message should still be persisted in store
      const rows = db.prepare('SELECT * FROM messages WHERE session_name = ?').all('sess-a') as Array<{ content: string }>;
      assert.equal(rows.length, 1);
    });

    it('clears in-memory tracked IDs for the session after completion', async () => {
      tracker.track('sess-a', 10, 'msg');
      const sink = createMockOutputSink(null);

      await tracker.persistAndDelete('sess-a', sink);

      // Track new message and persist again -- should only have the new one
      tracker.track('sess-a', 20, 'new msg');
      await tracker.persistAndDelete('sess-a', sink);

      // Check delete calls -- second call should only have ID 20
      const deleteCalls = mockApi.calls.filter(c => c.method === 'deleteMessages');
      assert.equal(deleteCalls.length, 2);
      const secondDeleteIds = deleteCalls[1].args[1] as number[];
      assert.deepEqual(secondDeleteIds, [20]);
    });
  });

  describe('restore()', () => {
    it('loads messages from store, re-sends via sendMessage, returns last message state', async () => {
      // Pre-populate store with persisted messages
      store.save('sess-a', 10, 'msg one', 1);
      store.save('sess-a', 11, 'msg two', 2);

      const result = await tracker.restore('sess-a');

      assert.ok(result !== null);
      // Should have sent 2 messages
      const sendCalls = mockApi.calls.filter(c => c.method === 'sendMessage');
      assert.equal(sendCalls.length, 2);

      // Last message state should be from the second send
      assert.equal(result!.text, 'msg two');
      assert.ok(result!.messageId > 0);
    });

    it('caps restoration to the last 20 messages (MAX_RESTORE)', async () => {
      // Insert 25 messages
      for (let i = 1; i <= 25; i++) {
        store.save('sess-a', i, `msg-${i}`, i);
      }

      await tracker.restore('sess-a');

      // Should only send 20 messages (the last 20)
      const sendCalls = mockApi.calls.filter(c => c.method === 'sendMessage');
      assert.equal(sendCalls.length, 20);

      // First restored message should be msg-6 (25 - 20 + 1 = 6)
      const firstText = sendCalls[0].args[1] as string;
      assert.ok(firstText.includes('msg-6'), `Expected first restored to be msg-6, got: ${firstText}`);
    });

    it('returns null if no messages exist for the session', async () => {
      const result = await tracker.restore('empty-session');
      assert.equal(result, null);

      // No API calls should have been made
      assert.equal(mockApi.calls.length, 0);
    });

    it('cleans up persisted records from store after successful restoration', async () => {
      store.save('sess-a', 10, 'msg one', 1);
      store.save('sess-a', 11, 'msg two', 2);

      await tracker.restore('sess-a');

      // Old persisted records should be deleted
      const rows = store.getBySession('sess-a');
      assert.equal(rows.length, 0, 'Persisted records should be cleaned after restore');
    });
  });

  describe('updateContent()', () => {
    it('sets content for an already-tracked messageId, and persistAndDelete uses that content', async () => {
      // Track a message WITHOUT content
      tracker.track('sess-a', 10);

      // Now update its content via updateContent
      tracker.updateContent('sess-a', 10, 'filled-in content');

      const sink = createMockOutputSink(null);
      await tracker.persistAndDelete('sess-a', sink);

      // The store should have the content set by updateContent
      const rows = db.prepare('SELECT * FROM messages WHERE session_name = ?').all('sess-a') as Array<{
        telegram_message_id: number;
        content: string;
      }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].telegram_message_id, 10);
      assert.equal(rows[0].content, 'filled-in content');
    });

    it('on an untracked messageId still sets content in the map (no error)', () => {
      // Should not throw
      tracker.updateContent('sess-a', 999, 'orphan content');

      // Verify the content is accessible by tracking and persisting
      tracker.track('sess-a', 999);
      const sink = createMockOutputSink(null);
      return tracker.persistAndDelete('sess-a', sink).then(() => {
        const rows = db.prepare('SELECT * FROM messages WHERE session_name = ?').all('sess-a') as Array<{
          content: string;
        }>;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].content, 'orphan content');
      });
    });
  });

  describe('archive()', () => {
    it('calls persistAndDelete then updates status to archived', async () => {
      tracker.track('sess-a', 10, 'msg');
      const sink = createMockOutputSink(null);

      await tracker.archive('sess-a', sink);

      // Message should be persisted
      const rows = db.prepare('SELECT * FROM messages WHERE session_name = ?').all('sess-a') as Array<{ status: string }>;
      assert.equal(rows.length, 1);
      // Status should be archived
      assert.equal(rows[0].status, 'archived');
    });

    it('clears tracked IDs for the session', async () => {
      tracker.track('sess-a', 10, 'msg');
      const sink = createMockOutputSink(null);

      await tracker.archive('sess-a', sink);

      // Track a new message and archive again
      tracker.track('sess-a', 20, 'new msg');
      await tracker.archive('sess-a', sink);

      // Second archive should only delete the new message
      const deleteCalls = mockApi.calls.filter(c => c.method === 'deleteMessages');
      assert.equal(deleteCalls.length, 2);
      const secondDeleteIds = deleteCalls[1].args[1] as number[];
      assert.deepEqual(secondDeleteIds, [20]);
    });
  });
});
