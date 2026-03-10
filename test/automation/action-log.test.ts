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

  it('adding 25 entries stores all 25 (no hard cap)', () => {
    const log = new ActionLog();
    for (let i = 1; i <= 25; i++) {
      log.add(`action-${i}`, `outcome-${i}`);
    }

    assert.equal(log.length, 25);
    const entries = log.getRecent();
    assert.equal(entries[0].action, 'action-1');
    assert.equal(entries[24].action, 'action-25');
  });

  it('100 add() calls stores all 100 entries (compression handles scaling, no cap)', () => {
    const log = new ActionLog();
    for (let i = 1; i <= 100; i++) {
      log.add(`action-${i}`, `outcome-${i}`);
    }

    assert.equal(log.length, 100);
    const entries = log.getRecent();
    assert.equal(entries[0].action, 'action-1');
    assert.equal(entries[99].action, 'action-100');
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

describe('ActionLog.getCompressed', () => {
  it('with 0 entries returns summary=null and empty recent array', () => {
    const log = new ActionLog();
    const result = log.getCompressed();

    assert.equal(result.summary, null);
    assert.deepEqual(result.recent, []);
    assert.equal(result.totalCount, 0);
  });

  it('with 5 entries and recentCount=10 returns summary=null and all 5 as recent (below threshold)', () => {
    const log = new ActionLog();
    for (let i = 1; i <= 5; i++) {
      log.add(`COMMAND: action-${i}`, `outcome-${i}`);
    }

    const result = log.getCompressed(10);

    assert.equal(result.summary, null);
    assert.equal(result.recent.length, 5);
    assert.equal(result.totalCount, 5);
    assert.equal(result.recent[0].action, 'COMMAND: action-1');
    assert.equal(result.recent[4].action, 'COMMAND: action-5');
  });

  it('with 25 entries and recentCount=10 returns summary covering entries 1-15 and 10 recent entries', () => {
    const log = new ActionLog();
    for (let i = 1; i <= 25; i++) {
      log.add(`COMMAND: action-${i}`, `outcome-${i}`);
    }

    const result = log.getCompressed(10);

    assert.ok(result.summary !== null, 'summary should not be null');
    assert.equal(result.recent.length, 10);
    assert.equal(result.totalCount, 25);
    // Recent entries should be the last 10 (16-25)
    assert.equal(result.recent[0].action, 'COMMAND: action-16');
    assert.equal(result.recent[9].action, 'COMMAND: action-25');
    // Summary should mention the action count
    assert.ok(result.summary!.includes('15'), 'summary should reference count of old entries');
  });

  it('with 50 entries and recentCount=5 returns summary covering entries 1-45 and 5 recent entries', () => {
    const log = new ActionLog();
    for (let i = 1; i <= 50; i++) {
      log.add(`COMMAND: action-${i}`, `outcome-${i}`);
    }

    const result = log.getCompressed(5);

    assert.ok(result.summary !== null, 'summary should not be null');
    assert.equal(result.recent.length, 5);
    assert.equal(result.totalCount, 50);
    // Recent entries should be the last 5 (46-50)
    assert.equal(result.recent[0].action, 'COMMAND: action-46');
    assert.equal(result.recent[4].action, 'COMMAND: action-50');
  });

  it('summary includes directive type counts', () => {
    const log = new ActionLog();
    // Add a mix of directive types (need more than recentCount so compression triggers)
    for (let i = 0; i < 15; i++) {
      log.add('COMMAND: do something', 'done');
    }
    for (let i = 0; i < 2; i++) {
      log.add('CLEAR', 'cleared');
    }
    log.add('RESET', 'reset done');
    // Add 5 recent entries to push the above into old
    for (let i = 0; i < 5; i++) {
      log.add('ENTER', 'entered');
    }

    const result = log.getCompressed(5);

    assert.ok(result.summary !== null, 'summary should exist');
    // Summary should mention COMMAND count
    assert.ok(result.summary!.includes('15') && result.summary!.includes('COMMAND'),
      `Summary should include COMMAND count: ${result.summary}`);
    // Summary should mention CLEAR count
    assert.ok(result.summary!.includes('2') && result.summary!.includes('CLEAR'),
      `Summary should include CLEAR count: ${result.summary}`);
    // Summary should mention RESET count
    assert.ok(result.summary!.includes('1') && result.summary!.includes('RESET'),
      `Summary should include RESET count: ${result.summary}`);
  });

  it('summary includes outcome keywords -- counts of successful vs failed vs pending', () => {
    const log = new ActionLog();
    // 8 successful, 3 failed, 2 pending (13 old entries)
    for (let i = 0; i < 8; i++) {
      log.add(`COMMAND: cmd-${i}`, 'Tests passed successfully');
    }
    for (let i = 0; i < 3; i++) {
      log.add(`COMMAND: fail-${i}`, 'Build failed with errors');
    }
    for (let i = 0; i < 2; i++) {
      log.add(`COMMAND: pending-${i}`, '(awaiting result)');
    }
    // Add recent entries to push above into old
    for (let i = 0; i < 5; i++) {
      log.add(`COMMAND: recent-${i}`, 'done');
    }

    const result = log.getCompressed(5);

    assert.ok(result.summary !== null, 'summary should exist');
    assert.ok(result.summary!.toLowerCase().includes('successful') || result.summary!.includes('8'),
      `Summary should include successful count: ${result.summary}`);
    assert.ok(result.summary!.toLowerCase().includes('failed') || result.summary!.includes('3'),
      `Summary should include failed count: ${result.summary}`);
    assert.ok(result.summary!.toLowerCase().includes('pending') || result.summary!.includes('2'),
      `Summary should include pending count: ${result.summary}`);
  });

  it('summary mentions escalations by reason if any ESCALATE entries exist', () => {
    const log = new ActionLog();
    for (let i = 0; i < 10; i++) {
      log.add('COMMAND: do work', 'done');
    }
    log.add('ESCALATE: Out of memory', 'escalated');
    log.add('ESCALATE: Permission denied', 'escalated');
    // Push into old
    for (let i = 0; i < 5; i++) {
      log.add('COMMAND: recent', 'done');
    }

    const result = log.getCompressed(5);

    assert.ok(result.summary !== null, 'summary should exist');
    assert.ok(result.summary!.includes('Out of memory'),
      `Summary should mention escalation reason "Out of memory": ${result.summary}`);
    assert.ok(result.summary!.includes('Permission denied'),
      `Summary should mention escalation reason "Permission denied": ${result.summary}`);
  });

  it('getCompressed() default recentCount is 10', () => {
    const log = new ActionLog();
    for (let i = 1; i <= 20; i++) {
      log.add(`COMMAND: action-${i}`, `outcome-${i}`);
    }

    const result = log.getCompressed();

    assert.ok(result.summary !== null, 'summary should exist with default recentCount=10');
    assert.equal(result.recent.length, 10);
    assert.equal(result.recent[0].action, 'COMMAND: action-11');
    assert.equal(result.recent[9].action, 'COMMAND: action-20');
  });
});
