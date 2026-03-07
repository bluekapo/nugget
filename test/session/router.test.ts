import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRouter } from '../../src/session/router.js';

/** Minimal mock for TelegramOutputSink (post-Phase 9: no attach/detach) */
function createMockOutputSink() {
  return {
    getCurrentState: mock.fn(() => null),
    restoreState: mock.fn((_state: { messageId: number; text: string }) => {}),
    clearCurrent: mock.fn(() => {}),
  };
}

/** Create a mock MessageTracker with call tracking. */
function createMockTracker() {
  return {
    persistAndDelete: mock.fn(async (_session: string, _sink: unknown) => {}),
    restore: mock.fn(async (_session: string) => null as { messageId: number; text: string } | null),
    archive: mock.fn(async (_session: string, _sink: unknown) => {}),
  };
}

/** Minimal mock for EventBus */
function createMockBus() {
  return {
    on() {},
    emit() {},
    off() {},
  };
}

describe('SessionRouter', () => {
  let sink: ReturnType<typeof createMockOutputSink>;
  let bus: ReturnType<typeof createMockBus>;
  let hubUpdateCount: number;
  let router: SessionRouter;

  beforeEach(() => {
    sink = createMockOutputSink();
    bus = createMockBus();
    hubUpdateCount = 0;
    router = new SessionRouter(
      sink as unknown as Parameters<typeof SessionRouter['prototype']['switchTo']> extends never[] ? never : any,
      bus as any,
      () => { hubUpdateCount++; },
    );
  });

  it('activeSession is null initially', () => {
    assert.equal(router.activeSession, null);
  });

  it('add() tracks a session', () => {
    router.add('project-a');
    assert.ok(router.has('project-a'));
    assert.deepEqual(router.getAll(), ['project-a']);
  });

  it('has() returns false for untracked session', () => {
    assert.equal(router.has('nope'), false);
  });

  it('getAll() returns all tracked sessions', () => {
    router.add('a');
    router.add('b');
    router.add('c');
    const all = router.getAll().sort();
    assert.deepEqual(all, ['a', 'b', 'c']);
  });

  it('remove() removes a tracked session', () => {
    router.add('x');
    router.remove('x');
    assert.equal(router.has('x'), false);
    assert.deepEqual(router.getAll(), []);
  });

  it('remove() nulls activeSession if the active session is removed', () => {
    router.add('active');
    router.switchTo('active');

    router.remove('active');

    assert.equal(router.activeSession, null);
  });

  it('remove() of non-active session preserves activeSession', () => {
    router.add('a');
    router.add('b');
    router.switchTo('a');

    router.remove('b');

    assert.equal(router.activeSession, 'a');
  });

  it('switchTo() throws if session is not tracked', () => {
    assert.throws(
      () => router.switchTo('unknown'),
      { message: /not found/ },
    );
  });

  it('switchTo() sets activeSession and triggers hub update', () => {
    router.add('a');
    router.add('b');
    router.switchTo('a');
    hubUpdateCount = 0;

    router.switchTo('b');

    assert.equal(router.activeSession, 'b');
    assert.equal(hubUpdateCount, 1);
  });

  it('switchTo() calls onHubUpdate callback', () => {
    router.add('a');
    hubUpdateCount = 0;

    router.switchTo('a');

    assert.equal(hubUpdateCount, 1);
  });

  it('switchTo() is a no-op if name is already active', () => {
    router.add('a');
    router.switchTo('a');
    hubUpdateCount = 0;

    router.switchTo('a');

    // No hub update
    assert.equal(hubUpdateCount, 0);
  });
});

describe('SessionRouter with MessageTracker', () => {
  let sink: ReturnType<typeof createMockOutputSink>;
  let bus: ReturnType<typeof createMockBus>;
  let tracker: ReturnType<typeof createMockTracker>;
  let hubUpdateCount: number;
  let router: SessionRouter;

  beforeEach(() => {
    sink = createMockOutputSink();
    bus = createMockBus();
    tracker = createMockTracker();
    hubUpdateCount = 0;
    router = new SessionRouter(
      sink as any,
      bus as any,
      () => { hubUpdateCount++; },
      tracker,
    );
  });

  it('switchTo() calls messageTracker.persistAndDelete for the old active session', async () => {
    router.add('a');
    router.add('b');
    router.switchTo('a');
    await new Promise(r => setTimeout(r, 50)); // let first lifecycle settle
    tracker.persistAndDelete.mock.resetCalls();
    tracker.restore.mock.resetCalls();

    router.switchTo('b');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(tracker.persistAndDelete.mock.callCount(), 1);
    assert.equal(tracker.persistAndDelete.mock.calls[0].arguments[0], 'a');
  });

  it('switchTo() calls messageTracker.restore for the new session', async () => {
    router.add('a');
    router.add('b');
    router.switchTo('a');
    await new Promise(r => setTimeout(r, 50)); // let first lifecycle settle
    tracker.restore.mock.resetCalls();

    router.switchTo('b');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(tracker.restore.mock.callCount(), 1);
    assert.equal(tracker.restore.mock.calls[0].arguments[0], 'b');
  });

  it('switchTo() calls outputSink.restoreState with the restore result if non-null', async () => {
    const restoreResult = { messageId: 42, text: 'restored text' };
    tracker.restore = mock.fn(async () => restoreResult);
    // Re-create router with the updated tracker
    router = new SessionRouter(sink as any, bus as any, () => { hubUpdateCount++; }, tracker);

    router.add('a');
    router.add('b');
    router.switchTo('a');
    await new Promise(r => setTimeout(r, 50)); // let first lifecycle settle
    sink.restoreState.mock.resetCalls();

    router.switchTo('b');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(sink.restoreState.mock.callCount(), 1);
    assert.deepEqual(sink.restoreState.mock.calls[0].arguments[0], restoreResult);
  });

  it('switchTo() on same session does not trigger persist/delete/restore', async () => {
    router.add('a');
    router.switchTo('a');
    await new Promise(r => setTimeout(r, 50)); // let first lifecycle settle
    tracker.persistAndDelete.mock.resetCalls();
    tracker.restore.mock.resetCalls();

    router.switchTo('a'); // no-op
    await new Promise(r => setTimeout(r, 50));

    assert.equal(tracker.persistAndDelete.mock.callCount(), 0);
    assert.equal(tracker.restore.mock.callCount(), 0);
  });

  it('remove() calls messageTracker.archive for the removed session', async () => {
    router.add('a');
    router.switchTo('a');

    router.remove('a');
    await new Promise(r => setTimeout(r, 50));

    assert.equal(tracker.archive.mock.callCount(), 1);
    assert.equal(tracker.archive.mock.calls[0].arguments[0], 'a');
  });

  it('remove() called twice for the same session triggers archive() exactly once', async () => {
    router.add('a');
    router.switchTo('a');
    tracker.archive.mock.resetCalls();

    router.remove('a');
    router.remove('a'); // second call -- should be no-op
    await new Promise(r => setTimeout(r, 50));

    assert.equal(tracker.archive.mock.callCount(), 1, 'archive should be called exactly once');
  });

  it('remove() for a session not in the set is a silent no-op (no error, no archive)', async () => {
    // Never added 'ghost' session
    router.remove('ghost'); // should not throw or call archive
    await new Promise(r => setTimeout(r, 50));

    assert.equal(tracker.archive.mock.callCount(), 0, 'archive should not be called for unknown session');
  });

  it('remove() of non-active session still archives', async () => {
    router.add('a');
    router.add('b');
    router.switchTo('a');

    router.remove('b');
    await new Promise(r => setTimeout(r, 50));

    // Should still archive even though b is not active
    assert.equal(tracker.archive.mock.callCount(), 1);
    assert.equal(tracker.archive.mock.calls[0].arguments[0], 'b');
  });

  it('switchTo() with no previous active session skips persistAndDelete', async () => {
    router.add('a');

    router.switchTo('a'); // first switch, no previous session
    await new Promise(r => setTimeout(r, 50));

    assert.equal(tracker.persistAndDelete.mock.callCount(), 0);
    // But restore should still be called for the new session
    assert.equal(tracker.restore.mock.callCount(), 1);
  });
});
