import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrations.js';
import { SessionStore } from '../../src/db/sessions.js';

describe('SessionStore.cleanupStale', () => {
  let db: ReturnType<typeof openDatabase>;
  let store: SessionStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nugget-test-${randomUUID()}`);
    const dbPath = join(tempDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db);
    store = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('deletes starting/running/stopping records and returns count', () => {
    // Create 3 sessions with stale statuses
    store.create('sess-starting');
    // status defaults to 'starting' on create, no need to update

    store.create('sess-running');
    store.updateStatus('sess-running', 'running');

    store.create('sess-stopping');
    store.updateStatus('sess-stopping', 'stopping');

    const count = store.cleanupStale();

    assert.equal(count, 3, 'should delete 3 stale records');
    assert.equal(store.findByName('sess-starting'), null, 'starting session should be deleted');
    assert.equal(store.findByName('sess-running'), null, 'running session should be deleted');
    assert.equal(store.findByName('sess-stopping'), null, 'stopping session should be deleted');
  });

  it('leaves stopped records untouched', () => {
    store.create('sess-stopped');
    store.updateStatus('sess-stopped', 'stopped');

    const count = store.cleanupStale();

    assert.equal(count, 0, 'should not delete stopped records');
    const session = store.findByName('sess-stopped');
    assert.ok(session, 'stopped session should still exist');
    assert.equal(session.status, 'stopped');
  });

  it('returns 0 when no stale records exist', () => {
    const count = store.cleanupStale();
    assert.equal(count, 0, 'should return 0 on empty database');
  });
});
