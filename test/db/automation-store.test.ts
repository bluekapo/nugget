import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrations.js';
import { AutomationStore } from '../../src/db/automation-store.js';
import type { PersistedAutomation } from '../../src/db/automation-store.js';

describe('AutomationStore', () => {
  let db: ReturnType<typeof openDatabase>;
  let store: AutomationStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nugget-test-${randomUUID()}`);
    const dbPath = join(tempDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db);
    store = new AutomationStore(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeAutomation(overrides?: Partial<PersistedAutomation>): PersistedAutomation {
    return {
      id: 1,
      workerSession: 'worker-1',
      orchestratorSession: 'orch-1',
      taskDescription: 'run all tests',
      engineState: 'idle',
      cycleCount: 3,
      lastAction: 'COMMAND: npm test',
      actionLog: [
        { action: 'COMMAND: npm install', outcome: 'success', timestamp: 1000 },
        { action: 'COMMAND: npm test', outcome: 'success', timestamp: 2000 },
      ],
      startTime: 1700000000000,
      ...overrides,
    };
  }

  it('save() inserts a new automation record; loadAll() returns it with correct fields', () => {
    const auto = makeAutomation();
    store.save(auto);

    const loaded = store.loadAll();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 1);
    assert.equal(loaded[0].workerSession, 'worker-1');
    assert.equal(loaded[0].orchestratorSession, 'orch-1');
    assert.equal(loaded[0].taskDescription, 'run all tests');
    assert.equal(loaded[0].engineState, 'idle');
    assert.equal(loaded[0].cycleCount, 3);
    assert.equal(loaded[0].lastAction, 'COMMAND: npm test');
    assert.equal(loaded[0].startTime, 1700000000000);
  });

  it('save() with existing id updates the record (upsert behavior)', () => {
    const auto = makeAutomation();
    store.save(auto);

    // Update with same id
    store.save({ ...auto, cycleCount: 10, engineState: 'paused' });

    const loaded = store.loadAll();
    assert.equal(loaded.length, 1, 'should still have 1 record after upsert');
    assert.equal(loaded[0].cycleCount, 10);
    assert.equal(loaded[0].engineState, 'paused');
  });

  it('remove(id) deletes the record; loadAll() returns empty', () => {
    store.save(makeAutomation());
    assert.equal(store.loadAll().length, 1);

    store.remove(1);
    assert.equal(store.loadAll().length, 0);
  });

  it('clearAll() removes all records', () => {
    store.save(makeAutomation({ id: 1 }));
    store.save(makeAutomation({ id: 2, workerSession: 'worker-2' }));
    assert.equal(store.loadAll().length, 2);

    store.clearAll();
    assert.equal(store.loadAll().length, 0);
  });

  it('save() stores action_log_json as valid JSON; loadAll() parses it back to ActionEntry[]', () => {
    const actionLog = [
      { action: 'COMMAND: ls', outcome: 'success', timestamp: 1000 },
      { action: 'ENTER', outcome: 'awaiting', timestamp: 2000 },
      { action: 'ESCALATE: need help', outcome: 'failed', timestamp: 3000 },
    ];
    store.save(makeAutomation({ actionLog }));

    const loaded = store.loadAll();
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0].actionLog, actionLog);
  });

  it('loadAll() returns empty array when no records exist', () => {
    const loaded = store.loadAll();
    assert.deepEqual(loaded, []);
  });
});
