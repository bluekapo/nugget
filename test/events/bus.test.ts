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

});
