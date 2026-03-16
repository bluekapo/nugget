import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRouter } from '../../src/session/router.js';

/** Minimal mock for EventBus */
function createMockBus() {
  return {
    on() {},
    emit() {},
    off() {},
  };
}

describe('SessionRouter', () => {
  let bus: ReturnType<typeof createMockBus>;
  let hubUpdateCount: number;
  let router: SessionRouter;

  beforeEach(() => {
    bus = createMockBus();
    hubUpdateCount = 0;
    router = new SessionRouter(
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

  it('remove() calls onHubUpdate', () => {
    router.add('a');
    router.switchTo('a');
    hubUpdateCount = 0;

    router.remove('a');

    assert.equal(hubUpdateCount, 1);
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

  it('switchTo() fires onSessionSwitch with old and new session names', () => {
    const switchCalls: Array<{ from: string | null; to: string }> = [];
    router.onSessionSwitch = (from, to) => {
      switchCalls.push({ from, to });
    };

    router.add('a');
    router.add('b');
    router.switchTo('a');
    router.switchTo('b');

    assert.equal(switchCalls.length, 2);
    assert.deepEqual(switchCalls[0], { from: null, to: 'a' });
    assert.deepEqual(switchCalls[1], { from: 'a', to: 'b' });
  });

  it('switchTo() with no previous session fires onSessionSwitch(null, newSession)', () => {
    const switchCalls: Array<{ from: string | null; to: string }> = [];
    router.onSessionSwitch = (from, to) => {
      switchCalls.push({ from, to });
    };

    router.add('first');
    router.switchTo('first');

    assert.equal(switchCalls.length, 1);
    assert.deepEqual(switchCalls[0], { from: null, to: 'first' });
  });

  it('switchTo() triggers local redraw for local sessions', () => {
    const redraws: string[] = [];
    router.onLocalRedraw = (name) => { redraws.push(name); };

    router.add('local');
    router.switchTo('local');

    assert.deepEqual(redraws, ['local']);
  });

  it('switchTo() does not fire onSessionSwitch on no-op (same session)', () => {
    const switchCalls: Array<{ from: string | null; to: string }> = [];
    router.onSessionSwitch = (from, to) => {
      switchCalls.push({ from, to });
    };

    router.add('a');
    router.switchTo('a');
    switchCalls.length = 0; // reset

    router.switchTo('a'); // no-op

    assert.equal(switchCalls.length, 0);
  });

  it('remove() for a session not in the set is a silent no-op', () => {
    hubUpdateCount = 0;
    router.remove('ghost'); // should not throw
    assert.equal(hubUpdateCount, 0);
  });

  it('addRemote() stores metadata and getRemoteMetadata() retrieves it', () => {
    const bridge = { sendInput() {}, onOutput() {}, requestRedraw() {}, sendPromote() {}, sendExit() {} };
    router.addRemote('remote-1', bridge as any, { pid: 42, createdAt: '2026-03-16T10:00:00' });

    const meta = router.getRemoteMetadata('remote-1');
    assert.deepEqual(meta, { pid: 42, createdAt: '2026-03-16T10:00:00' });
  });

  it('removeRemote() clears metadata', () => {
    const bridge = { sendInput() {}, onOutput() {}, requestRedraw() {}, sendPromote() {}, sendExit() {} };
    router.addRemote('remote-2', bridge as any, { pid: 99 });

    router.removeRemote('remote-2');

    assert.equal(router.getRemoteMetadata('remote-2'), undefined);
    assert.equal(router.has('remote-2'), false);
  });

  it('getRemoteMetadata() returns undefined for unknown sessions', () => {
    assert.equal(router.getRemoteMetadata('nonexistent'), undefined);
  });
});
