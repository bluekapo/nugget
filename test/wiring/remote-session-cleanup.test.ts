/**
 * Behavioral tests for remote session cleanup parity:
 *
 * When a remote (IPC) session unregisters, the primary must perform the SAME
 * cleanup as a local session:exit -- emulator disposal, clearExecState,
 * completionTracker.removeSession, and auto-switch to next available session.
 *
 * These tests extract a `makeCleanupSession` factory that mirrors the
 * production cleanup logic in index.ts and verify all operations happen.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Factory: shared cleanup logic (mirrors index.ts cleanupSession helper)
//
// This factory must be importable from the production code or defined to
// match the exact production behavior. Currently lives in index.ts as a
// local function, so we replicate the contract here.
// ---------------------------------------------------------------------------

import { makeCleanupSession } from '../../src/cleanup.js';

// ---------------------------------------------------------------------------
// Minimal interfaces matching what the factory needs
// ---------------------------------------------------------------------------

interface MockRouter {
  activeSession: string | null;
  remove(name: string): void;
  getAll(): string[];
  switchTo(name: string): void;
}

interface MockHubRenderer {
  clearExecState(name: string): void;
  render(): void;
}

interface MockCompletionTracker {
  removeSession(name: string): void;
}

interface MockEmulator {
  dispose(): void;
}

// ===========================================================================
// Remote session cleanup tests
// ===========================================================================

describe('Remote session cleanup parity', () => {
  let router: MockRouter;
  let hubRenderer: MockHubRenderer;
  let completionTracker: MockCompletionTracker;
  let emulators: Map<string, MockEmulator>;
  let cleanupSession: (name: string) => void;

  // Track calls via mock.fn()
  let removeFn: ReturnType<typeof mock.fn>;
  let switchToFn: ReturnType<typeof mock.fn>;
  let clearExecStateFn: ReturnType<typeof mock.fn>;
  let renderFn: ReturnType<typeof mock.fn>;
  let removeSessionFn: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    removeFn = mock.fn();
    switchToFn = mock.fn();
    clearExecStateFn = mock.fn();
    renderFn = mock.fn();
    removeSessionFn = mock.fn();

    router = {
      activeSession: 'remote-1',
      remove: removeFn as unknown as (name: string) => void,
      getAll: () => ['local-1'],
      switchTo: switchToFn as unknown as (name: string) => void,
    };

    hubRenderer = {
      clearExecState: clearExecStateFn as unknown as (name: string) => void,
      render: renderFn as unknown as () => void,
    };

    completionTracker = {
      removeSession: removeSessionFn as unknown as (name: string) => void,
    };

    emulators = new Map();

    cleanupSession = makeCleanupSession(router, hubRenderer, completionTracker, emulators);
  });

  it('disposes emulator and removes it from the emulators Map', () => {
    const disposeFn = mock.fn();
    const emu: MockEmulator = { dispose: disposeFn as unknown as () => void };
    emulators.set('remote-1', emu);

    cleanupSession('remote-1');

    assert.equal(disposeFn.mock.callCount(), 1, 'emulator.dispose() should be called');
    assert.equal(emulators.has('remote-1'), false, 'emulator should be removed from Map');
  });

  it('calls hubRenderer.clearExecState for the session', () => {
    cleanupSession('remote-1');

    assert.equal(clearExecStateFn.mock.callCount(), 1, 'clearExecState should be called once');
    assert.equal(
      (clearExecStateFn.mock.calls[0] as { arguments: string[] }).arguments[0],
      'remote-1',
      'clearExecState should be called with the session name',
    );
  });

  it('calls completionTracker.removeSession for the session', () => {
    cleanupSession('remote-1');

    assert.equal(removeSessionFn.mock.callCount(), 1, 'removeSession should be called once');
    assert.equal(
      (removeSessionFn.mock.calls[0] as { arguments: string[] }).arguments[0],
      'remote-1',
      'removeSession should be called with the session name',
    );
  });

  it('auto-switches to next available session when cleaned-up session was active', () => {
    // router.activeSession is 'remote-1', so after remove it becomes null
    // We need remove to simulate setting activeSession to null
    router.remove = ((name: string) => {
      removeFn(name);
      if (router.activeSession === name) {
        router.activeSession = null;
      }
    }) as (name: string) => void;

    cleanupSession('remote-1');

    assert.equal(switchToFn.mock.callCount(), 1, 'switchTo should be called once');
    assert.equal(
      (switchToFn.mock.calls[0] as { arguments: string[] }).arguments[0],
      'local-1',
      'switchTo should switch to the next available session',
    );
  });

  it('does NOT auto-switch when cleaned-up session was NOT the active session', () => {
    // Set active to something else so the cleaned session is not active
    router.activeSession = 'local-1';

    cleanupSession('remote-1');

    assert.equal(switchToFn.mock.callCount(), 0, 'switchTo should NOT be called');
  });
});
