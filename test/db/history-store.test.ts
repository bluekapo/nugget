import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrations.js';
import { HistoryStore } from '../../src/db/history-store.js';
import type { HistoryRecord } from '../../src/db/history-store.js';

describe('HistoryStore', () => {
  let db: ReturnType<typeof openDatabase>;
  let store: HistoryStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nugget-test-${randomUUID()}`);
    const dbPath = join(tempDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db);
    store = new HistoryStore(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeRecord(overrides?: Partial<Omit<HistoryRecord, 'id'>>): Omit<HistoryRecord, 'id'> {
    return {
      orchestratorSession: 'orch-1',
      workerSession: 'worker-1',
      taskDescription: 'run all tests',
      startTime: 1700000000000,
      endTime: 1700000060000,
      durationMs: 60000,
      cycleCount: 5,
      outcome: 'done',
      ...overrides,
    };
  }

  it('insert() stores a history record; loadAll() returns it with all fields correct', () => {
    store.insert(makeRecord());

    const loaded = store.loadAll();
    assert.equal(loaded.length, 1);
    assert.equal(typeof loaded[0].id, 'number');
    assert.equal(loaded[0].orchestratorSession, 'orch-1');
    assert.equal(loaded[0].workerSession, 'worker-1');
    assert.equal(loaded[0].taskDescription, 'run all tests');
    assert.equal(loaded[0].startTime, 1700000000000);
    assert.equal(loaded[0].endTime, 1700000060000);
    assert.equal(loaded[0].durationMs, 60000);
    assert.equal(loaded[0].cycleCount, 5);
    assert.equal(loaded[0].outcome, 'done');
  });

  it('loadAll() returns records ordered by endTime descending (newest first)', () => {
    store.insert(makeRecord({ endTime: 1700000010000, durationMs: 10000 }));
    store.insert(makeRecord({ endTime: 1700000030000, durationMs: 30000 }));
    store.insert(makeRecord({ endTime: 1700000020000, durationMs: 20000 }));

    const loaded = store.loadAll();
    assert.equal(loaded.length, 3);
    assert.equal(loaded[0].endTime, 1700000030000, 'newest first');
    assert.equal(loaded[1].endTime, 1700000020000, 'middle');
    assert.equal(loaded[2].endTime, 1700000010000, 'oldest last');
  });

  it('loadAll() returns empty array when no records exist', () => {
    const loaded = store.loadAll();
    assert.deepEqual(loaded, []);
  });

  it('clearAll() removes all history records', () => {
    store.insert(makeRecord());
    store.insert(makeRecord({ workerSession: 'worker-2' }));
    assert.equal(store.loadAll().length, 2);

    store.clearAll();
    assert.equal(store.loadAll().length, 0);
  });

  it('insert() with different outcomes (done, error, stopped) all persist correctly', () => {
    store.insert(makeRecord({ outcome: 'done' }));
    store.insert(makeRecord({ outcome: 'error', endTime: 1700000070000 }));
    store.insert(makeRecord({ outcome: 'stopped', endTime: 1700000080000 }));

    const loaded = store.loadAll();
    assert.equal(loaded.length, 3);
    const outcomes = loaded.map(r => r.outcome).sort();
    assert.deepEqual(outcomes, ['done', 'error', 'stopped']);
  });
});
