import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActionLog } from '../../src/automation/action-log.js';

describe('ActionLog', () => {
  it('add() stores an action with action string, outcome string, and timestamp', () => {
    const log = new ActionLog();
    const before = Date.now();
    log.add('COMMAND: npm test', 'Tests passed');
    const after = Date.now();

    const entries = log.getRecent();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'COMMAND: npm test');
    assert.equal(entries[0].outcome, 'Tests passed');
    assert.ok(entries[0].timestamp >= before, 'timestamp should be >= before');
    assert.ok(entries[0].timestamp <= after, 'timestamp should be <= after');
  });

  it('getRecent() returns entries in chronological order (oldest first)', () => {
    const log = new ActionLog();
    log.add('action-1', 'outcome-1');
    log.add('action-2', 'outcome-2');
    log.add('action-3', 'outcome-3');

    const entries = log.getRecent();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].action, 'action-1');
    assert.equal(entries[1].action, 'action-2');
    assert.equal(entries[2].action, 'action-3');
  });

  it('length property returns current entry count', () => {
    const log = new ActionLog();
    assert.equal(log.length, 0);

    log.add('a', 'b');
    assert.equal(log.length, 1);

    log.add('c', 'd');
    assert.equal(log.length, 2);
  });

  it('adding 25 entries with default max (20) results in length === 20 and oldest 5 dropped', () => {
    const log = new ActionLog();
    for (let i = 1; i <= 25; i++) {
      log.add(`action-${i}`, `outcome-${i}`);
    }

    assert.equal(log.length, 20);
    const entries = log.getRecent();
    // Oldest 5 (action-1..action-5) should be dropped
    assert.equal(entries[0].action, 'action-6');
    assert.equal(entries[19].action, 'action-25');
  });

  it('custom maxEntries -- new ActionLog(5), add 8 entries, length === 5, only last 5 remain', () => {
    const log = new ActionLog(5);
    for (let i = 1; i <= 8; i++) {
      log.add(`action-${i}`, `outcome-${i}`);
    }

    assert.equal(log.length, 5);
    const entries = log.getRecent();
    assert.equal(entries[0].action, 'action-4');
    assert.equal(entries[4].action, 'action-8');
  });

  it('getRecent(3) returns only the last 3 entries', () => {
    const log = new ActionLog();
    for (let i = 1; i <= 10; i++) {
      log.add(`action-${i}`, `outcome-${i}`);
    }

    const entries = log.getRecent(3);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].action, 'action-8');
    assert.equal(entries[1].action, 'action-9');
    assert.equal(entries[2].action, 'action-10');
  });

  it('clear() removes all entries, length === 0', () => {
    const log = new ActionLog();
    log.add('a', 'b');
    log.add('c', 'd');
    assert.equal(log.length, 2);

    log.clear();
    assert.equal(log.length, 0);
    assert.deepEqual(log.getRecent(), []);
  });

  it('empty log -- getRecent() returns empty array', () => {
    const log = new ActionLog();
    const entries = log.getRecent();
    assert.deepEqual(entries, []);
  });

  // ---------- updateLastOutcome tests ----------

  it('updateLastOutcome() replaces the outcome of the most recent entry', () => {
    const log = new ActionLog();
    log.add('COMMAND: npm test', '(awaiting result)');
    log.updateLastOutcome('Tests passed - 42 tests');

    const entries = log.getRecent();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'COMMAND: npm test');
    assert.equal(entries[0].outcome, 'Tests passed - 42 tests');
  });

  it('updateLastOutcome() on empty log is a no-op (no crash)', () => {
    const log = new ActionLog();
    // Should not throw
    log.updateLastOutcome('some outcome');
    assert.equal(log.length, 0);
  });

  it('updateLastOutcome() only affects the last entry (previous entries unchanged)', () => {
    const log = new ActionLog();
    log.add('action-1', 'outcome-1');
    log.add('action-2', 'outcome-2');
    log.add('action-3', 'outcome-3');
    log.updateLastOutcome('updated-outcome-3');

    const entries = log.getRecent();
    assert.equal(entries[0].outcome, 'outcome-1', 'first entry unchanged');
    assert.equal(entries[1].outcome, 'outcome-2', 'second entry unchanged');
    assert.equal(entries[2].outcome, 'updated-outcome-3', 'last entry updated');
  });
});
