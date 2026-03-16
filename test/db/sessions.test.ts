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

  it('deletes rows with null PID (no PID recorded)', () => {
    // Create sessions without assigning PIDs — cleanupStale should delete them
    store.create('sess-starting');
    store.create('sess-running');
    store.updateStatus('sess-running', 'running');
    store.create('sess-stopping');
    store.updateStatus('sess-stopping', 'stopping');

    const count = store.cleanupStale();

    assert.equal(count, 3, 'should delete 3 null-PID stale records');
    assert.equal(store.findByName('sess-starting'), null);
    assert.equal(store.findByName('sess-running'), null);
    assert.equal(store.findByName('sess-stopping'), null);
  });

  it('preserves rows for alive PIDs', () => {
    // Use current process PID — guaranteed to be alive
    store.create('alive-session');
    store.updateStatus('alive-session', 'running');
    store.updatePid('alive-session', process.pid);

    const count = store.cleanupStale();

    assert.equal(count, 0, 'should not delete rows for alive PIDs');
    const session = store.findByName('alive-session');
    assert.ok(session, 'alive session should still exist');
    assert.equal(session.pid, process.pid);
  });

  it('deletes rows for dead PIDs', () => {
    // Use a PID that is (almost certainly) not alive
    store.create('dead-session');
    store.updateStatus('dead-session', 'running');
    store.updatePid('dead-session', 999999);

    const count = store.cleanupStale();

    assert.equal(count, 1, 'should delete row for dead PID');
    assert.equal(store.findByName('dead-session'), null);
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
