import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrations.js';
import { SessionStore } from '../../src/db/sessions.js';

// --- openDatabase tests ---

describe('openDatabase', () => {
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nugget-test-${randomUUID()}`);
    dbPath = join(tempDir, 'test.db');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns a Database instance with WAL mode enabled', () => {
    const db = openDatabase(dbPath);
    const mode = db.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');
    db.close();
  });

  it('enables foreign keys', () => {
    const db = openDatabase(dbPath);
    const fk = db.pragma('foreign_keys', { simple: true });
    assert.equal(fk, 1);
    db.close();
  });

  it('creates parent directory if it does not exist', () => {
    const nested = join(tempDir, 'sub', 'dir', 'test.db');
    const db = openDatabase(nested);
    assert.ok(existsSync(join(tempDir, 'sub', 'dir')));
    db.close();
  });
});

// --- runMigrations tests ---

describe('runMigrations', () => {
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nugget-test-${randomUUID()}`);
    dbPath = join(tempDir, 'test.db');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates sessions and messages tables on fresh database', () => {
    const db = openDatabase(dbPath);
    runMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions', 'messages') ORDER BY name"
    ).all() as Array<{ name: string }>;
    assert.equal(tables.length, 2);

    const version = db.pragma('user_version', { simple: true });
    assert.equal(version, 7);

    db.close();
  });

  it('is idempotent -- running twice does not error', () => {
    const db = openDatabase(dbPath);
    runMigrations(db);
    runMigrations(db); // second call should not throw
    const version = db.pragma('user_version', { simple: true });
    assert.equal(version, 7);
    db.close();
  });
});

// --- SessionStore tests ---

describe('SessionStore', () => {
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

  it('create() inserts a session and returns the Session object', () => {
    const session = store.create('my-session');
    assert.equal(session.name, 'my-session');
    assert.equal(session.status, 'starting');
    assert.equal(session.pid, null);
    assert.ok(session.id > 0);
    assert.ok(typeof session.createdAt === 'string');
    assert.ok(typeof session.updatedAt === 'string');
  });

  it('create() throws on duplicate name', () => {
    store.create('dup-session');
    assert.throws(() => {
      store.create('dup-session');
    });
  });

  it('findByName() returns Session when found', () => {
    store.create('find-me');
    const found = store.findByName('find-me');
    assert.ok(found !== null);
    assert.equal(found!.name, 'find-me');
  });

  it('findByName() returns null when not found', () => {
    const found = store.findByName('nonexistent');
    assert.equal(found, null);
  });

  it('updateStatus() updates status and updated_at', () => {
    store.create('status-test');
    store.updateStatus('status-test', 'running');
    const session = store.findByName('status-test');
    assert.equal(session!.status, 'running');
  });

  it('updatePid() updates pid and updated_at', () => {
    store.create('pid-test');
    store.updatePid('pid-test', 12345);
    const session = store.findByName('pid-test');
    assert.equal(session!.pid, 12345);
  });

  it('getActive() returns sessions with status starting or running', () => {
    store.create('active-1');
    store.create('active-2');
    store.create('stopped-1');

    store.updateStatus('active-1', 'running');
    // active-2 stays as 'starting'
    store.updateStatus('stopped-1', 'stopped');

    const active = store.getActive();
    assert.equal(active.length, 2);
    const names = active.map((s) => s.name).sort();
    assert.deepEqual(names, ['active-1', 'active-2']);
  });

  it('delete() removes the session row', () => {
    store.create('delete-me');
    assert.ok(store.findByName('delete-me') !== null);
    store.delete('delete-me');
    assert.equal(store.findByName('delete-me'), null);
  });
});
