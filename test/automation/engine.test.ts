import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/events/bus.js';
import { AutomationEngine } from '../../src/automation/engine.js';
import type { EngineState, EngineConfig } from '../../src/automation/engine.js';
import type { TimerProvider } from '../../src/terminal/capture.js';

/**
 * ManualTimer -- deterministic timer for testing ScreenCapture debounce and engine delays.
 * Copied from capture.test.ts pattern.
 */
class ManualTimer implements TimerProvider {
  private _now = 0;
  private _nextId = 1;
  private _timers = new Map<number, { callback: () => void; fireAt: number }>();

  setTimeout(callback: () => void, delay: number): number {
    const id = this._nextId++;
    this._timers.set(id, { callback, fireAt: this._now + delay });
    return id;
  }

  clearTimeout(id: unknown): void {
    this._timers.delete(id as number);
  }

  now(): number {
    return this._now;
  }

  advance(ms: number): void {
    const target = this._now + ms;
    while (this._now < target) {
      let earliest: { id: number; entry: { callback: () => void; fireAt: number } } | null = null;
      for (const [id, entry] of this._timers) {
        if (entry.fireAt <= target) {
          if (!earliest || entry.fireAt < earliest.entry.fireAt) {
            earliest = { id, entry };
          }
        }
      }
      if (earliest && earliest.entry.fireAt <= target) {
        this._now = earliest.entry.fireAt;
        this._timers.delete(earliest.id);
        earliest.entry.callback();
      } else {
        this._now = target;
      }
    }
  }

  get pendingCount(): number {
    return this._timers.size;
  }
}

/**
 * Flush the microtask queue. ScreenCapture.onData() is async because
 * TerminalEmulator.write() returns a Promise. After emitting bus events
 * that trigger capture.onData(), we must flush to let the emulator process
 * the data before advancing the ManualTimer.
 */
async function flush(): Promise<void> {
  // Multiple rounds to drain nested microtasks
  for (let i = 0; i < 5; i++) {
    await new Promise<void>(r => globalThis.setTimeout(r, 0));
  }
}

/** Simulate Claude Code completion marker in PTY output */
function completionOutput(text: string = 'some output'): string {
  return `${text}\r\n\u273B Crunched for 1m 22s\r\n`;
}

/** Simulate orchestrator responding with a directive */
function directiveOutput(directive: string): string {
  return `${directive}\r\n\u273B Crunched for 5s\r\n`;
}

/**
 * Emit session output and flush the microtask queue so the async
 * ScreenCapture.onData() -> TerminalEmulator.write() chain completes
 * before we advance the ManualTimer.
 */
async function emitOutput(bus: EventBus, session: string, data: string): Promise<void> {
  bus.emit('session:output', session, data);
  await flush();
}

describe('AutomationEngine', () => {
  let bus: EventBus;
  let timer: ManualTimer;
  let engine: AutomationEngine;
  let writes: Array<{ name: string; data: string }>;
  let mockSessionManager: { writeToSession: (name: string, data: string) => void };
  let config: EngineConfig;

  beforeEach(() => {
    bus = new EventBus();
    timer = new ManualTimer();
    writes = [];
    mockSessionManager = {
      writeToSession: (name: string, data: string) => {
        writes.push({ name, data });
      },
    };
    config = {
      workerSession: 'worker',
      orchestratorSession: 'orchestrator',
      taskDescription: 'Run the tests',
      timer,
      baseDelay: 50,
      idleDelay: 100,
    };
  });

  afterEach(() => {
    engine?.stop();
  });

  // ---------- Test 1: start/stop lifecycle ----------

  it('starts in stopped state, start() transitions to idle, stop() returns to stopped', () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    assert.equal(engine.state, 'stopped', 'should start in stopped state');

    engine.start();
    assert.equal(engine.state, 'idle', 'start() should transition to idle');

    engine.stop();
    assert.equal(engine.state, 'stopped', 'stop() should transition to stopped');
  });

  // ---------- Test 2: worker idle triggers state transition ----------

  it('worker idle triggers capturing-worker state', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Emit worker session:output with completion marker, then flush microtasks
    await emitOutput(bus, 'worker', completionOutput('test results'));

    // Advance past baseDelay (debounce) + idleDelay (completion detection)
    timer.advance(50);  // debounce fires, capture runs, crunched=true
    timer.advance(100); // idle fires -> onPromptComplete -> state changes

    // After onWorkerIdle, state transitions through capturing-worker -> clearing-orchestrator
    // We check that it moved past idle (capturing-worker was transient)
    assert.notEqual(engine.state, 'idle', 'should have left idle state on worker idle');
    assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator after capturing worker');
  });

  // ---------- Test 3: full COMMAND cycle ----------

  it('full COMMAND cycle: worker idle -> capture -> /clear -> prompt -> parse -> execute', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const cycleEvents: Array<{ cycle: number; action: string }> = [];
    bus.on('automation:cycle-complete', (cycle, action) => {
      cycleEvents.push({ cycle, action });
    });

    engine.start();

    // Step 1: Worker goes idle (completion detected)
    await emitOutput(bus, 'worker', completionOutput('$ npm test\nall tests passed'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle -> onPromptComplete fires

    // Engine should have captured worker screen and sent /clear to orchestrator
    const clearWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('/clear'));
    assert.ok(clearWrite, 'engine should send /clear to orchestrator');

    // Step 2: Orchestrator processes /clear (completion marker)
    await emitOutput(bus, 'orchestrator', completionOutput('/clear processed'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle -> onPromptComplete for clear

    // Engine should have sent prompt to orchestrator
    const promptWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('## Task'));
    assert.ok(promptWrite, 'engine should send prompt to orchestrator');

    // Step 3: Orchestrator responds with directive
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: npm test'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle -> onPromptComplete for response

    // Engine should have written command to worker
    const cmdWrite = writes.find(w => w.name === 'worker' && w.data.includes('npm test'));
    assert.ok(cmdWrite, 'engine should write command to worker');

    // Verify cycle-complete event was emitted
    assert.equal(cycleEvents.length, 1, 'should emit one cycle-complete event');
    assert.equal(cycleEvents[0].cycle, 1, 'should be cycle 1');
    assert.ok(cycleEvents[0].action.includes('COMMAND'), 'action should mention COMMAND');
  });

  // ---------- Test 4: ESCALATE pauses engine ----------

  it('ESCALATE directive pauses engine and emits escalation event', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const escalations: string[] = [];
    bus.on('automation:escalation', (reason) => {
      escalations.push(reason);
    });

    engine.start();

    // Worker goes idle
    await emitOutput(bus, 'worker', completionOutput('task output'));
    timer.advance(50);
    timer.advance(100);

    // Orchestrator clears
    await emitOutput(bus, 'orchestrator', completionOutput('cleared'));
    timer.advance(50);
    timer.advance(100);

    // Engine sends prompt, orchestrator responds with ESCALATE
    await emitOutput(bus, 'orchestrator', directiveOutput('ESCALATE: task is complete'));
    timer.advance(50);
    timer.advance(100);

    assert.equal(engine.state, 'paused', 'ESCALATE should pause the engine');
    assert.equal(escalations.length, 1, 'should emit one escalation event');
    assert.ok(escalations[0].includes('task is complete'), 'escalation should contain the reason');
  });

  // ---------- Test 5: WAIT delays next cycle ----------

  it('WAIT directive delays before re-entering idle', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Worker idle
    await emitOutput(bus, 'worker', completionOutput('running'));
    timer.advance(50);
    timer.advance(100);

    // Clear
    await emitOutput(bus, 'orchestrator', completionOutput('cleared'));
    timer.advance(50);
    timer.advance(100);

    // Orchestrator responds with WAIT: 5
    await emitOutput(bus, 'orchestrator', directiveOutput('WAIT: 5'));
    timer.advance(50);
    timer.advance(100);

    assert.equal(engine.state, 'waiting', 'should be in waiting state after WAIT directive');

    // Advance 4 seconds -- still waiting
    timer.advance(4000);
    assert.equal(engine.state, 'waiting', 'should still be waiting after 4s');

    // Advance remaining 1 second -- should re-enter idle
    timer.advance(1000);
    assert.equal(engine.state, 'idle', 'should return to idle after wait period');
  });

  // ---------- Test 6: pause/resume ----------

  it('pause/resume: pause during idle, resume re-arms worker detection', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();
    assert.equal(engine.state, 'idle');

    engine.pause();
    assert.equal(engine.state, 'paused', 'pause() should transition to paused');

    engine.resume();
    assert.equal(engine.state, 'idle', 'resume() should transition back to idle');

    // Worker idle should still trigger after resume
    await emitOutput(bus, 'worker', completionOutput('after resume'));
    timer.advance(50);
    timer.advance(100);
    assert.equal(engine.state, 'clearing-orchestrator', 'worker idle should trigger after resume');
  });

  // ---------- Test 7: pause during wait ignores callback ----------

  it('pause during orchestrator wait: onPromptComplete fires but engine stays paused', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Worker idle -> engine starts capture flow
    await emitOutput(bus, 'worker', completionOutput('data'));
    timer.advance(50);
    timer.advance(100);

    // Now engine is waiting for orchestrator /clear completion
    // Pause the engine mid-flow
    engine.pause();
    assert.equal(engine.state, 'paused');

    // Orchestrator completes -- but engine is paused, should ignore
    await emitOutput(bus, 'orchestrator', completionOutput('cleared'));
    timer.advance(50);
    timer.advance(100);

    // Should still be paused, not sending prompt
    assert.equal(engine.state, 'paused', 'should remain paused even after orchestrator completion');

    // Verify no prompt was sent to orchestrator (only /clear was sent before pause)
    const promptWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('## Task'));
    assert.equal(promptWrites.length, 0, 'no prompt should be sent while paused');
  });

  // ---------- Test 8: stop cleanup ----------

  it('stop() disposes monitors, clears timers, removes bus listeners', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Start some activity
    await emitOutput(bus, 'worker', completionOutput('data'));
    timer.advance(50);

    // Stop while pending
    engine.stop();
    assert.equal(engine.state, 'stopped');

    // Emit more session output -- should NOT cause errors or state changes
    bus.emit('session:output', 'worker', completionOutput('after stop'));
    timer.advance(50);
    timer.advance(100);

    assert.equal(engine.state, 'stopped', 'should remain stopped after bus events');
    assert.equal(timer.pendingCount, 0, 'should have no pending timers after stop');
  });

  // ---------- Test 9: state-change events emitted ----------

  it('emits automation:state-change events on transitions', () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const stateChanges: string[] = [];
    bus.on('automation:state-change', (state) => {
      stateChanges.push(state);
    });

    engine.start();
    assert.ok(stateChanges.includes('idle'), 'should emit idle state change on start');

    engine.pause();
    assert.ok(stateChanges.includes('paused'), 'should emit paused state change');

    engine.resume();
    // idle appears again
    const idleCount = stateChanges.filter(s => s === 'idle').length;
    assert.ok(idleCount >= 2, 'should emit idle again on resume');

    engine.stop();
    assert.ok(stateChanges.includes('stopped'), 'should emit stopped state change');
  });

  // ---------- Test 10: SELECT uses async arrow-down with delays ----------

  it('SELECT directive sends arrow-down keys with delays to worker', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Worker idle
    await emitOutput(bus, 'worker', completionOutput('menu displayed'));
    timer.advance(50);
    timer.advance(100);

    // Clear
    await emitOutput(bus, 'orchestrator', completionOutput('cleared'));
    timer.advance(50);
    timer.advance(100);

    // Orchestrator responds with SELECT: 3 (needs 2 arrow-downs then Enter)
    await emitOutput(bus, 'orchestrator', directiveOutput('SELECT: 3'));
    timer.advance(50);
    timer.advance(100);

    // Engine handles SELECT with delays, advance enough for arrow key delays
    // Default arrowKeyDelayMs=50, 2 arrow-downs + Enter
    timer.advance(50); // second arrow-down scheduled
    timer.advance(50); // Enter

    // Verify arrow-down and Enter sequences were written to worker
    const workerWrites = writes.filter(w => w.name === 'worker');
    const arrowDowns = workerWrites.filter(w => w.data === '\x1b[B');
    const enters = workerWrites.filter(w => w.data === '\r');
    assert.equal(arrowDowns.length, 2, 'should send 2 arrow-down keys for SELECT: 3');
    assert.ok(enters.length >= 1, 'should send Enter after arrow-downs');
  });

  // ---------- Test 11: SAF-01 Cycle limit stops engine ----------

  it('SAF-01: engine stops when cycleNumber reaches maxCycles', async () => {
    config.maxCycles = 2;
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (err) => errors.push(err));

    engine.start();

    // Complete cycle 1
    await emitOutput(bus, 'worker', completionOutput('cycle 1'));
    timer.advance(50); timer.advance(100);
    await emitOutput(bus, 'orchestrator', completionOutput('cleared'));
    timer.advance(50); timer.advance(100);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo 1'));
    timer.advance(50); timer.advance(100);

    assert.equal(engine.state, 'idle', 'should be idle after cycle 1');

    // Complete cycle 2
    await emitOutput(bus, 'worker', completionOutput('cycle 2'));
    timer.advance(50); timer.advance(100);
    await emitOutput(bus, 'orchestrator', completionOutput('cleared'));
    timer.advance(50); timer.advance(100);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo 2'));
    timer.advance(50); timer.advance(100);

    assert.equal(engine.state, 'idle', 'should be idle after cycle 2');

    // Cycle 3 attempt: worker goes idle but engine should hit cycle limit
    await emitOutput(bus, 'worker', completionOutput('cycle 3'));
    timer.advance(50); timer.advance(100);

    assert.equal(engine.state, 'stopped', 'should be stopped after hitting cycle limit');
    assert.ok(errors.some(e => e.includes('Cycle limit')), 'should emit automation:error with Cycle limit message');
  });

  // ---------- Test 12: SAF-01 with maxCycles=3 ----------

  it('SAF-01: engine with maxCycles=3 stops after 3 cycles and emits error', async () => {
    config.maxCycles = 3;
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    const cycles: number[] = [];
    bus.on('automation:error', (err) => errors.push(err));
    bus.on('automation:cycle-complete', (cycle) => cycles.push(cycle));

    engine.start();

    // Run 3 complete cycles
    for (let i = 1; i <= 3; i++) {
      await emitOutput(bus, 'worker', completionOutput(`cycle ${i}`));
      timer.advance(50); timer.advance(100);
      await emitOutput(bus, 'orchestrator', completionOutput('cleared'));
      timer.advance(50); timer.advance(100);
      await emitOutput(bus, 'orchestrator', directiveOutput(`COMMAND: echo ${i}`));
      timer.advance(50); timer.advance(100);
    }

    assert.equal(cycles.length, 3, 'should complete exactly 3 cycles');

    // Cycle 4 attempt: hits limit
    await emitOutput(bus, 'worker', completionOutput('cycle 4'));
    timer.advance(50); timer.advance(100);

    assert.equal(engine.state, 'stopped', 'should be stopped after hitting cycle limit');
    assert.ok(errors.some(e => e.includes('Cycle limit')), 'should emit automation:error with Cycle limit');
  });

  // ---------- Test 13: SAF-02 Parse retry on first failure ----------

  it('SAF-02: engine retries once with clarifying re-prompt when directive parse fails', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (err) => errors.push(err));

    engine.start();

    // Worker idle -> clear -> prompt
    await emitOutput(bus, 'worker', completionOutput('data'));
    timer.advance(50); timer.advance(100);
    await emitOutput(bus, 'orchestrator', completionOutput('cleared'));
    timer.advance(50); timer.advance(100);

    // Orchestrator responds with unparseable text
    await emitOutput(bus, 'orchestrator', directiveOutput('I think we should run tests'));
    timer.advance(50); timer.advance(100);

    // Engine should be in waiting-response (retrying), not idle or stopped
    assert.equal(engine.state, 'waiting-response', 'should be waiting for retry response');

    // Verify a clarifying re-prompt was sent to orchestrator
    const retryWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('could not be parsed'));
    assert.ok(retryWrites.length >= 1, 'should send clarifying re-prompt to orchestrator');
  });

  // ---------- Test 14: SAF-02 ESCALATE after retry also fails ----------

  it('SAF-02: engine ESCALATEs when retry also fails to parse', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const escalations: string[] = [];
    bus.on('automation:escalation', (reason) => escalations.push(reason));

    engine.start();

    // Worker idle -> clear -> prompt
    await emitOutput(bus, 'worker', completionOutput('data'));
    timer.advance(50); timer.advance(100);
    await emitOutput(bus, 'orchestrator', completionOutput('cleared'));
    timer.advance(50); timer.advance(100);

    // First unparseable response -> triggers retry
    await emitOutput(bus, 'orchestrator', directiveOutput('I think we should run tests'));
    timer.advance(50); timer.advance(100);

    assert.equal(engine.state, 'waiting-response', 'should be waiting for retry response');

    // Second unparseable response -> should ESCALATE
    await emitOutput(bus, 'orchestrator', directiveOutput('Hmm let me think about that'));
    timer.advance(50); timer.advance(100);

    assert.equal(engine.state, 'paused', 'should be paused after double parse failure');
    assert.ok(escalations.some(e => e.includes('parse')), 'should emit escalation about parse failure');
  });

  // ---------- Test 15: SAF-03 Worker session disconnect ----------

  it('SAF-03: engine stops when worker session:exit fires during automation', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (err) => errors.push(err));

    engine.start();
    assert.equal(engine.state, 'idle');

    // Worker session exits
    bus.emit('session:exit', 'worker', 1);

    assert.equal(engine.state, 'stopped', 'should stop on worker session exit');
    assert.ok(errors.some(e => e.includes('Worker') && e.includes('disconnected')), 'should emit error about Worker disconnect');
  });

  // ---------- Test 16: SAF-03 Orchestrator session disconnect ----------

  it('SAF-03: engine stops when orchestrator session:exit fires during automation', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (err) => errors.push(err));

    engine.start();
    assert.equal(engine.state, 'idle');

    // Orchestrator session exits
    bus.emit('session:exit', 'orchestrator', 0);

    assert.equal(engine.state, 'stopped', 'should stop on orchestrator session exit');
    assert.ok(errors.some(e => e.includes('Orchestrator') && e.includes('disconnected')), 'should emit error about Orchestrator disconnect');
  });

  // ---------- Test 17: SAF-03 Ignores unrelated session:exit ----------

  it('SAF-03: engine ignores session:exit for unrelated sessions', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (err) => errors.push(err));

    engine.start();
    assert.equal(engine.state, 'idle');

    // Unrelated session exits
    bus.emit('session:exit', 'unrelated-session', 0);

    assert.equal(engine.state, 'idle', 'should remain idle when unrelated session exits');
    assert.equal(errors.length, 0, 'should not emit any errors for unrelated session');
  });

  // ---------- Test 18: SAF-03 session:exit listener cleaned up on stop ----------

  it('SAF-03: session:exit listener is cleaned up on stop()', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (err) => errors.push(err));

    engine.start();
    engine.stop();

    // Emit session:exit after stop -- should NOT trigger error
    bus.emit('session:exit', 'worker', 1);

    assert.equal(errors.length, 0, 'should not emit errors after stop cleans up listener');
  });
});

// ---------- SettingsStore numeric methods ----------

import Database from 'better-sqlite3';
import { SettingsStore } from '../../src/db/settings-store.js';

describe('SettingsStore numeric methods', () => {
  let db: Database.Database;
  let store: SettingsStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    store = new SettingsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('getNumber returns default when key not found', () => {
    assert.equal(store.getNumber('nonexistent', 42), 42);
  });

  it('getNumber returns stored number after setNumber', () => {
    store.setNumber('maxCycles', 200);
    assert.equal(store.getNumber('maxCycles', 100), 200);
  });

  it('getNumber returns default when stored value is not a number', () => {
    // Store a non-numeric string using the boolean set method
    store.set('badValue', true);
    // 'true' is not a valid number, so getNumber should return default
    assert.equal(store.getNumber('badValue', 50), 50);
  });
});
