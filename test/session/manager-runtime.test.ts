/**
 * RT-01: setRuntimeMode + getDefaultSpawnFn integration
 *
 * Tests that NUGGET_RUNTIME=container causes session spawn to use
 * `docker start -ai <name>` vs NUGGET_RUNTIME=sandbox using
 * `docker sandbox run <name>`.
 *
 * Strategy: inject fake node-pty into the CJS require cache before loading
 * pty.ts and manager.ts (same pattern as pty.test.ts). The manager's
 * internal `getDefaultSpawnFn()` does a dynamic import('./pty.js') which,
 * under tsx's CJS interop, resolves to the CJS-cached pty.ts — so the
 * injected fake intercepts spawn calls made by the default spawn path.
 *
 * Because manager.ts holds module-level state (_runtimeMode, _cachedSpawnFn),
 * we load a fresh module instance per test group to avoid state bleed.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---- Fake node-pty setup ----

const require = createRequire(import.meta.url);

interface SpawnCall {
  cmd: string;
  args: string[];
}

const spawnCalls: SpawnCall[] = [];

const fakeResult = {
  pid: 77777,
  onData: (_cb: (data: string) => void) => ({ dispose: () => {} }),
  onExit: (_cb: (e: { exitCode: number }) => void) => ({ dispose: () => {} }),
  kill: () => {},
  write: () => {},
  resize: () => {},
};

// Resolve node-pty CJS entry and inject fake before any pty.ts is loaded
const nodePtyPath = require.resolve('node-pty');
// biome-ignore lint: test fixture requires any
require.cache[nodePtyPath] = {
  id: nodePtyPath,
  filename: nodePtyPath,
  loaded: true,
  // biome-ignore lint: test fixture
  parent: null as any,
  children: [],
  paths: [],
  exports: {
    spawn: (cmd: string, args: string[]): typeof fakeResult => {
      spawnCalls.push({ cmd, args });
      return fakeResult;
    },
  },
// biome-ignore lint: test fixture
} as any;

// ---- Module paths ----

const PTY_PATH = new URL('../../src/session/pty.ts', import.meta.url).pathname;
const MANAGER_PATH = new URL('../../src/session/manager.ts', import.meta.url).pathname;
const DB_PATH = new URL('../../src/db/database.ts', import.meta.url).pathname;
const MIGRATIONS_PATH = new URL('../../src/db/migrations.ts', import.meta.url).pathname;
const SESSIONS_PATH = new URL('../../src/db/sessions.ts', import.meta.url).pathname;
const BUS_PATH = new URL('../../src/events/bus.ts', import.meta.url).pathname;

// ---- Helper: create a fresh in-memory test DB ----

function createTestDb() {
  const tempDir = join(tmpdir(), `nugget-rt-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  const dbPath = join(tempDir, 'test.db');

  const { openDatabase } = require(DB_PATH) as typeof import('../../src/db/database.js');
  const { runMigrations } = require(MIGRATIONS_PATH) as typeof import('../../src/db/migrations.js');
  const { SessionStore } = require(SESSIONS_PATH) as typeof import('../../src/db/sessions.js');
  const { EventBus } = require(BUS_PATH) as typeof import('../../src/events/bus.js');

  const db = openDatabase(dbPath);
  runMigrations(db);
  const store = new SessionStore(db);
  const bus = new EventBus();

  return { db, store, bus, tempDir };
}

// ---- Helper: load a fresh manager module (bypass CJS cache) ----
// This is needed because manager.ts holds module-level state (_runtimeMode,
// _cachedSpawnFn). Deleting the cache entry forces tsx to re-evaluate the
// module, resetting state to its initial values.

// biome-ignore lint: test fixture
type ManagerModule = typeof import('../../src/session/manager.js');

function loadFreshManager(): ManagerModule {
  // Pre-load pty.ts so the CJS cache entry exists before manager loads it
  if (!(PTY_PATH in require.cache)) {
    require(PTY_PATH);
  }
  // Force fresh manager module by removing existing cache entry
  delete require.cache[MANAGER_PATH];
  return require(MANAGER_PATH) as ManagerModule;
}

// ---- Tests ----

describe('setRuntimeMode + getDefaultSpawnFn (RT-01)', () => {
  before(() => {
    // Ensure pty.ts is in the CJS cache with our fake node-pty
    if (!(PTY_PATH in require.cache)) {
      require(PTY_PATH);
    }
  });

  describe('container mode causes docker start -ai spawn', () => {
    let managerMod: ManagerModule;

    before(() => {
      managerMod = loadFreshManager();
    });

    it('setRuntimeMode("container") + start() calls docker with start -ai args', async () => {
      spawnCalls.length = 0;
      const { db, store, bus, tempDir } = createTestDb();

      try {
        managerMod.setRuntimeMode('container');
        const manager = new managerMod.SessionManager(bus, store);

        await manager.start('my-container');

        assert.ok(spawnCalls.length > 0, 'pty.spawn must have been called');
        const call = spawnCalls[spawnCalls.length - 1];
        assert.equal(call.cmd, 'docker', 'command must be docker');
        assert.deepEqual(
          call.args,
          ['start', '-ai', 'my-container'],
          'args must be ["start", "-ai", name] for container mode',
        );
      } finally {
        db.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('sandbox mode causes docker sandbox run spawn', () => {
    let managerMod: ManagerModule;

    before(() => {
      managerMod = loadFreshManager();
    });

    it('setRuntimeMode("sandbox") + start() calls docker with sandbox run args', async () => {
      spawnCalls.length = 0;
      const { db, store, bus, tempDir } = createTestDb();

      try {
        managerMod.setRuntimeMode('sandbox');
        const manager = new managerMod.SessionManager(bus, store);

        await manager.start('my-sandbox');

        assert.ok(spawnCalls.length > 0, 'pty.spawn must have been called');
        const call = spawnCalls[spawnCalls.length - 1];
        assert.equal(call.cmd, 'docker', 'command must be docker');
        assert.deepEqual(
          call.args,
          ['sandbox', 'run', 'my-sandbox'],
          'args must be ["sandbox", "run", name] for sandbox mode',
        );
      } finally {
        db.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('cache invalidation: switching mode updates spawn function', () => {
    let managerMod: ManagerModule;

    before(() => {
      managerMod = loadFreshManager();
    });

    it('switching from sandbox to container clears cache and uses new spawn fn', async () => {
      spawnCalls.length = 0;
      const { db, store, bus, tempDir } = createTestDb();

      try {
        // First: sandbox mode — spawns with sandbox run
        managerMod.setRuntimeMode('sandbox');
        const manager1 = new managerMod.SessionManager(bus, store);
        await manager1.start('first-session');

        const sandboxCall = spawnCalls[spawnCalls.length - 1];
        assert.deepEqual(
          sandboxCall.args,
          ['sandbox', 'run', 'first-session'],
          'first call must use sandbox run',
        );

        // Now switch to container mode — cache must be invalidated
        managerMod.setRuntimeMode('container');
        const manager2 = new managerMod.SessionManager(bus, store);
        await manager2.start('second-session');

        const containerCall = spawnCalls[spawnCalls.length - 1];
        assert.deepEqual(
          containerCall.args,
          ['start', '-ai', 'second-session'],
          'after setRuntimeMode("container"), must use docker start -ai',
        );
      } finally {
        db.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('switching from container back to sandbox clears cache and restores sandbox fn', async () => {
      spawnCalls.length = 0;
      const { db, store, bus, tempDir } = createTestDb();

      try {
        // Start in container mode
        managerMod.setRuntimeMode('container');
        const manager1 = new managerMod.SessionManager(bus, store);
        await manager1.start('container-first');

        const containerCall = spawnCalls[spawnCalls.length - 1];
        assert.deepEqual(
          containerCall.args,
          ['start', '-ai', 'container-first'],
          'container mode must use start -ai',
        );

        // Switch back to sandbox — cache must be invalidated
        managerMod.setRuntimeMode('sandbox');
        const manager2 = new managerMod.SessionManager(bus, store);
        await manager2.start('sandbox-second');

        const sandboxCall = spawnCalls[spawnCalls.length - 1];
        assert.deepEqual(
          sandboxCall.args,
          ['sandbox', 'run', 'sandbox-second'],
          'after switching back to sandbox, must use sandbox run',
        );
      } finally {
        db.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('calling setRuntimeMode with the same mode does not clear cache (idempotent)', async () => {
      spawnCalls.length = 0;
      const { db, store, bus, tempDir } = createTestDb();

      try {
        // Load fresh module — starts in sandbox mode
        const freshMod = loadFreshManager();
        freshMod.setRuntimeMode('sandbox');

        const manager1 = new freshMod.SessionManager(bus, store);
        await manager1.start('session-a');
        const callCount1 = spawnCalls.length;

        // Call setRuntimeMode again with same value — should be a no-op
        freshMod.setRuntimeMode('sandbox');

        const manager2 = new freshMod.SessionManager(bus, store);
        await manager2.start('session-b');

        // Second session should still succeed using sandbox spawn
        const sandboxCall = spawnCalls[spawnCalls.length - 1];
        assert.deepEqual(
          sandboxCall.args,
          ['sandbox', 'run', 'session-b'],
          'same-mode re-set must not break subsequent spawns',
        );
        assert.equal(spawnCalls.length, callCount1 + 1, 'exactly one more spawn call');
      } finally {
        db.close();
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
