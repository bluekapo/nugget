import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrations.js';
import { SessionStore } from '../../src/db/sessions.js';
import { EventBus } from '../../src/events/bus.js';
import { SessionManager } from '../../src/session/manager.js';
import type { PtyOptions } from '../../src/session/pty.js';

// --- Fake PTY for testing ---

interface FakePtyHandle {
  onDataCallback: ((data: string) => void) | null;
  onExitCallback: ((e: { exitCode: number; signal?: number }) => void) | null;
  killed: boolean;
  paused: boolean;
  pid: number;
  written: string[];
  resized: Array<{ cols: number; rows: number }>;
}

function createFakePtySpawner() {
  const handles: Map<string, FakePtyHandle> = new Map();

  function fakeSpawn(opts: PtyOptions) {
    const handle: FakePtyHandle = {
      onDataCallback: null,
      onExitCallback: null,
      killed: false,
      paused: false,
      pid: 10000 + handles.size,
      written: [],
      resized: [],
    };
    handles.set(opts.name, handle);

    return {
      pid: handle.pid,
      onData(cb: (data: string) => void) {
        handle.onDataCallback = cb;
        return { dispose() { handle.onDataCallback = null; } };
      },
      onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
        handle.onExitCallback = cb;
        return { dispose() { handle.onExitCallback = null; } };
      },
      kill() {
        handle.killed = true;
      },
      resize(cols: number, rows: number) {
        handle.resized.push({ cols, rows });
      },
      write(data: string) {
        handle.written.push(data);
      },
      pause() {
        handle.paused = true;
      },
      resume() {
        handle.paused = false;
      },
    };
  }

  return { fakeSpawn, handles };
}

// --- SessionManager tests ---

describe('SessionManager', () => {
  let db: ReturnType<typeof openDatabase>;
  let store: SessionStore;
  let bus: EventBus;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nugget-test-${randomUUID()}`);
    const dbPath = join(tempDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db);
    store = new SessionStore(db);
    bus = new EventBus();
  });

  afterEach(() => {
    db.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('start() creates session in store, spawns PTY, returns Session', async () => {
    const { fakeSpawn } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    const session = await manager.start('test-session');
    assert.equal(session.name, 'test-session');
    assert.equal(session.status, 'running');
    assert.ok(session.pid !== null);
  });

  it('start() rejects duplicate session names', async () => {
    const { fakeSpawn } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    await manager.start('dup-session');
    await assert.rejects(
      () => manager.start('dup-session'),
      { message: /already exists/ }
    );
  });

  it('start() emits session:started on bus', async () => {
    const { fakeSpawn } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    let startedName: string | null = null;
    bus.on('session:started', (name: string) => {
      startedName = name;
    });

    await manager.start('emit-test');
    assert.equal(startedName, 'emit-test');
  });

  it('start() wires PTY onData to bus session:output', async () => {
    const { fakeSpawn, handles } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    const outputs: string[] = [];
    bus.on('session:output', (_name: string, data: string) => {
      outputs.push(data);
    });

    await manager.start('data-test');

    const handle = handles.get('data-test')!;
    assert.ok(handle.onDataCallback !== null);
    handle.onDataCallback!('hello world');
    handle.onDataCallback!('second line');

    assert.deepEqual(outputs, ['hello world', 'second line']);
  });

  it('start() wires PTY onExit to store status update and bus session:exit', async () => {
    const { fakeSpawn, handles } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    let exitName: string | null = null;
    let exitCode: number | null = null;
    bus.on('session:exit', (name: string, code: number) => {
      exitName = name;
      exitCode = code;
    });

    await manager.start('exit-test');

    const handle = handles.get('exit-test')!;
    handle.onExitCallback!({ exitCode: 0 });

    assert.equal(exitName, 'exit-test');
    assert.equal(exitCode, 0);

    const session = store.findByName('exit-test');
    assert.equal(session!.status, 'stopped');
  });

  it('stop() kills PTY process and updates status to stopping', async () => {
    const { fakeSpawn, handles } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    await manager.start('stop-test');

    await manager.stop('stop-test');

    const handle = handles.get('stop-test')!;
    assert.ok(handle.killed);

    const session = store.findByName('stop-test');
    assert.equal(session!.status, 'stopping');
  });

  it('stop() throws if session not found in active PTYs', async () => {
    const { fakeSpawn } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    await assert.rejects(
      () => manager.stop('nonexistent'),
      { message: /not found/ }
    );
  });

  it('getActive() returns active sessions from store', async () => {
    const { fakeSpawn } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    await manager.start('active-1');
    await manager.start('active-2');

    const active = manager.getActive();
    assert.equal(active.length, 2);
    const names = active.map((s) => s.name).sort();
    assert.deepEqual(names, ['active-1', 'active-2']);
  });

  it('writeToSession() calls pty.write with the given data', async () => {
    const { fakeSpawn, handles } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    await manager.start('write-test');
    manager.writeToSession('write-test', '/clear\n');
    manager.writeToSession('write-test', 'y\n');

    const handle = handles.get('write-test')!;
    assert.deepEqual(handle.written, ['/clear\n', 'y\n']);
  });

  it('writeToSession() throws when session name not found', async () => {
    const { fakeSpawn } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    assert.throws(
      () => manager.writeToSession('nonexistent', 'data'),
      { message: /not active/ }
    );
  });

  it('start() throws when MAX_SESSIONS concurrent sessions reached', async () => {
    const { fakeSpawn } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn, 2); // limit to 2

    await manager.start('session-1');
    await manager.start('session-2');

    await assert.rejects(
      () => manager.start('session-3'),
      { message: /Maximum 2 concurrent sessions reached/ },
    );
  });

  it('start() allows new sessions after exited sessions free up slots', async () => {
    const { fakeSpawn, handles } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn, 2);

    await manager.start('s1');
    await manager.start('s2');

    // Simulate s1 exiting -- frees a slot
    const handle = handles.get('s1')!;
    handle.onExitCallback!({ exitCode: 0 });

    // Should now succeed since only 1 active PTY remains
    const s3 = await manager.start('s3');
    assert.equal(s3.name, 's3');
  });

  it('constructor defaults maxSessions to 3', async () => {
    const { fakeSpawn } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    await manager.start('a');
    await manager.start('b');
    await manager.start('c');

    await assert.rejects(
      () => manager.start('d'),
      { message: /Maximum 3 concurrent sessions reached/ },
    );
  });

  it('writeToSession() throws after session has exited', async () => {
    const { fakeSpawn, handles } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    await manager.start('exit-write-test');

    // Trigger exit
    const handle = handles.get('exit-write-test')!;
    handle.onExitCallback!({ exitCode: 0 });

    assert.throws(
      () => manager.writeToSession('exit-write-test', 'data'),
      { message: /not active/ }
    );
  });

  it('resizeSession() calls pty.resize with correct cols/rows', async () => {
    const { fakeSpawn, handles } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    await manager.start('resize-test');
    manager.resizeSession('resize-test', 200, 50);

    const handle = handles.get('resize-test')!;
    assert.deepEqual(handle.resized, [{ cols: 200, rows: 50 }]);
  });

  it('resizeSession() throws when session name not found', () => {
    const { fakeSpawn } = createFakePtySpawner();
    const manager = new SessionManager(bus, store, fakeSpawn);

    assert.throws(
      () => manager.resizeSession('nonexistent', 120, 40),
      { message: /not active/ }
    );
  });

  describe('flow control (CAPT-05)', () => {
    it('pauseSession() calls pty.pause() on active session', async () => {
      const { fakeSpawn, handles } = createFakePtySpawner();
      const manager = new SessionManager(bus, store, fakeSpawn);

      await manager.start('pause-test');
      manager.pauseSession('pause-test');

      const handle = handles.get('pause-test')!;
      assert.equal(handle.paused, true, 'PTY should be paused');
    });

    it('resumeSession() calls pty.resume() on active session', async () => {
      const { fakeSpawn, handles } = createFakePtySpawner();
      const manager = new SessionManager(bus, store, fakeSpawn);

      await manager.start('resume-test');
      // Pause first, then resume
      manager.pauseSession('resume-test');
      const handle = handles.get('resume-test')!;
      assert.equal(handle.paused, true);

      manager.resumeSession('resume-test');
      assert.equal(handle.paused, false, 'PTY should be resumed');
    });

    it('pauseSession() silently ignores non-existent session', () => {
      const { fakeSpawn } = createFakePtySpawner();
      const manager = new SessionManager(bus, store, fakeSpawn);

      // Should not throw
      manager.pauseSession('nonexistent');
      assert.ok(true, 'pauseSession did not throw for non-existent session');
    });

    it('resumeSession() silently ignores non-existent session', () => {
      const { fakeSpawn } = createFakePtySpawner();
      const manager = new SessionManager(bus, store, fakeSpawn);

      // Should not throw
      manager.resumeSession('nonexistent');
      assert.ok(true, 'resumeSession did not throw for non-existent session');
    });

    it('pauseSession/resumeSession work correctly after session exit (no throw)', async () => {
      const { fakeSpawn, handles } = createFakePtySpawner();
      const manager = new SessionManager(bus, store, fakeSpawn);

      await manager.start('exit-flow-test');

      // Trigger exit -- removes from activePtys
      const handle = handles.get('exit-flow-test')!;
      handle.onExitCallback!({ exitCode: 0 });

      // Should not throw after session has exited
      manager.pauseSession('exit-flow-test');
      manager.resumeSession('exit-flow-test');
      assert.ok(true, 'pause/resume did not throw after session exit');
    });
  });
});
