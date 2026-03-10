import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeDirective, type ExecutionResult } from '../../src/automation/action-executor.js';

describe('executeDirective', () => {
  it('COMMAND writes command + carriage return to writeFn', () => {
    const writes: string[] = [];
    const writeFn = (data: string) => { writes.push(data); };

    const result = executeDirective({ type: 'COMMAND', command: 'npm test' }, writeFn);

    assert.deepStrictEqual(writes, ['npm test\r']);
    assert.strictEqual(result.executed, true);
    assert.strictEqual(result.description, 'COMMAND: npm test');
  });

  it('SELECT option 3 writes 2 arrow-downs then carriage return', () => {
    const writes: string[] = [];
    const writeFn = (data: string) => { writes.push(data); };

    const result = executeDirective({ type: 'SELECT', option: 3 }, writeFn);

    assert.deepStrictEqual(writes, ['\x1b[B', '\x1b[B', '\r']);
    assert.strictEqual(result.executed, true);
    assert.strictEqual(result.description, 'SELECT: 3');
  });

  it('SELECT option 1 writes only carriage return (zero arrow-downs)', () => {
    const writes: string[] = [];
    const writeFn = (data: string) => { writes.push(data); };

    const result = executeDirective({ type: 'SELECT', option: 1 }, writeFn);

    assert.deepStrictEqual(writes, ['\r']);
    assert.strictEqual(result.executed, true);
    assert.strictEqual(result.description, 'SELECT: 1');
  });

  it('ENTER writes carriage return only', () => {
    const writes: string[] = [];
    const writeFn = (data: string) => { writes.push(data); };

    const result = executeDirective({ type: 'ENTER' }, writeFn);

    assert.deepStrictEqual(writes, ['\r']);
    assert.strictEqual(result.executed, true);
    assert.strictEqual(result.description, 'ENTER');
  });

  it('ESCALATE returns escalateReason, sets executed=false, does NOT write', () => {
    const writes: string[] = [];
    const writeFn = (data: string) => { writes.push(data); };

    const result = executeDirective({ type: 'ESCALATE', reason: 'task complete' }, writeFn);

    assert.deepStrictEqual(writes, []);
    assert.strictEqual(result.executed, false);
    assert.strictEqual(result.description, 'ESCALATE: task complete');
    assert.strictEqual(result.escalateReason, 'task complete');
  });

  it('DONE returns doneSummary, sets executed=false, does NOT write', () => {
    const writes: string[] = [];
    const writeFn = (data: string) => { writes.push(data); };

    const result = executeDirective({ type: 'DONE', summary: 'All tests pass' }, writeFn);

    assert.deepStrictEqual(writes, []);
    assert.strictEqual(result.executed, false);
    assert.strictEqual(result.description, 'DONE: All tests pass');
    assert.strictEqual(result.doneSummary, 'All tests pass');
  });

  it('CLEAR returns executed=false with description, does NOT write', () => {
    const writes: string[] = [];
    const writeFn = (data: string) => { writes.push(data); };

    const result = executeDirective({ type: 'CLEAR' }, writeFn);

    assert.deepStrictEqual(writes, [], 'CLEAR should NOT call writeFn');
    assert.strictEqual(result.executed, false);
    assert.strictEqual(result.description, 'CLEAR');
  });

  it('RESET returns executed=false with description, does NOT write', () => {
    const writes: string[] = [];
    const writeFn = (data: string) => { writes.push(data); };

    const result = executeDirective({ type: 'RESET' }, writeFn);

    assert.deepStrictEqual(writes, [], 'RESET should NOT call writeFn');
    assert.strictEqual(result.executed, false);
    assert.strictEqual(result.description, 'RESET');
  });
});
