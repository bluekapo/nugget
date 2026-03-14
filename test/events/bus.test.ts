import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Will be implemented in bus.ts
import { EventBus } from '../../src/events/bus.js';
import type { BusEvents } from '../../src/events/bus.js';

describe('EventBus', () => {
  it('emits session:output and triggers registered listener', () => {
    const bus = new EventBus();
    let receivedName = '';
    let receivedData = '';

    bus.on('session:output', (name: string, data: string) => {
      receivedName = name;
      receivedData = data;
    });

    bus.emit('session:output', 'test-session', 'hello world');

    assert.equal(receivedName, 'test-session');
    assert.equal(receivedData, 'hello world');
  });

  it('off() removes listener so it no longer fires', () => {
    const bus = new EventBus();
    let callCount = 0;

    const listener = (_name: string, _data: string) => {
      callCount++;
    };

    bus.on('session:output', listener);
    bus.emit('session:output', 'test', 'data1');
    assert.equal(callCount, 1);

    bus.off('session:output', listener);
    bus.emit('session:output', 'test', 'data2');
    assert.equal(callCount, 1); // Should NOT have incremented
  });

  it('emits session:exit with sessionName and exitCode', () => {
    const bus = new EventBus();
    let receivedName = '';
    let receivedCode = -1;

    bus.on('session:exit', (name: string, exitCode: number) => {
      receivedName = name;
      receivedCode = exitCode;
    });

    bus.emit('session:exit', 'my-session', 0);

    assert.equal(receivedName, 'my-session');
    assert.equal(receivedCode, 0);
  });

  it('emits session:started with sessionName', () => {
    const bus = new EventBus();
    let receivedName = '';

    bus.on('session:started', (name: string) => {
      receivedName = name;
    });

    bus.emit('session:started', 'new-session');

    assert.equal(receivedName, 'new-session');
  });

  // ── removeAllListeners ────────────────────────────────────────────────

  describe('removeAllListeners', () => {
    it('removes all listeners from all events when called with no args', () => {
      const bus = new EventBus();
      let outputFired = false;
      let exitFired = false;

      bus.on('session:output', () => { outputFired = true; });
      bus.on('session:exit', () => { exitFired = true; });

      bus.removeAllListeners();

      bus.emit('session:output', 'test', 'data');
      bus.emit('session:exit', 'test', 0);

      assert.equal(outputFired, false, 'session:output listener should not fire after removeAllListeners()');
      assert.equal(exitFired, false, 'session:exit listener should not fire after removeAllListeners()');
    });

    it('removes only listeners for specified event when called with event name', () => {
      const bus = new EventBus();
      let outputFired = false;
      let exitFired = false;

      bus.on('session:output', () => { outputFired = true; });
      bus.on('session:exit', () => { exitFired = true; });

      bus.removeAllListeners('session:output');

      bus.emit('session:output', 'test', 'data');
      bus.emit('session:exit', 'test', 0);

      assert.equal(outputFired, false, 'session:output listener should not fire after removeAllListeners("session:output")');
      assert.equal(exitFired, true, 'session:exit listener should still fire');
    });
  });

  // ── listenerCount ─────────────────────────────────────────────────────

  describe('listenerCount', () => {
    it('returns 0 when no listeners registered', () => {
      const bus = new EventBus();
      assert.equal(bus.listenerCount('session:output'), 0);
    });

    it('returns 1 after one on() call', () => {
      const bus = new EventBus();
      const listener = (_name: string, _data: string) => {};
      bus.on('session:output', listener);
      assert.equal(bus.listenerCount('session:output'), 1);
    });

    it('returns 0 after on() then off()', () => {
      const bus = new EventBus();
      const listener = (_name: string, _data: string) => {};
      bus.on('session:output', listener);
      bus.off('session:output', listener);
      assert.equal(bus.listenerCount('session:output'), 0);
    });

    it('returns 2 after two on() calls', () => {
      const bus = new EventBus();
      const listener1 = (_name: string, _data: string) => {};
      const listener2 = (_name: string, _data: string) => {};
      bus.on('session:output', listener1);
      bus.on('session:output', listener2);
      assert.equal(bus.listenerCount('session:output'), 2);
    });
  });

  // ── once ──────────────────────────────────────────────────────────────

  describe('once', () => {
    it('fires exactly once and auto-removes', () => {
      const bus = new EventBus();
      let callCount = 0;

      bus.once('session:output', () => { callCount++; });

      assert.equal(bus.listenerCount('session:output'), 1, 'listener registered');

      bus.emit('session:output', 'test', 'data1');
      assert.equal(callCount, 1, 'fires on first emit');

      assert.equal(bus.listenerCount('session:output'), 0, 'auto-removed after first emit');

      bus.emit('session:output', 'test', 'data2');
      assert.equal(callCount, 1, 'does not fire on second emit');
    });
  });

});
