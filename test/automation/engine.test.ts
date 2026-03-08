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

/** Simulate Claude Code response without completion marker, just idle prompt */
function markerlessOutput(text: string = 'some output'): string {
  return `${text}\r\n\u276F \r\n`;
}

/** Simulate Claude Code /clear response with (no content) */
function clearOutput(): string {
  return '> /clear\r\n\r\n  \u23BF  (no content)\r\n';
}

/** Simulate orchestrator responding with a directive */
function directiveOutput(directive: string): string {
  return `● ${directive}\r\n\u273B Crunched for 5s\r\n`;
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

  // ---------- Test 2: first cycle triggers immediately on start() ----------

  it('first cycle triggers immediately on start() without waiting for worker output', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();
    assert.equal(engine.state, 'idle', 'start() sets idle synchronously');

    // Fire the deferred setTimeout(0) -- no session:output emitted at all
    // advance(1) because ManualTimer needs _now < target to enter the loop
    timer.advance(1);

    // Engine should have transitioned out of idle into clearing-orchestrator
    // (capturing-worker is transient within onWorkerIdle)
    assert.equal(engine.state, 'clearing-orchestrator',
      'engine should start first cycle immediately via deferred timer, without any worker output');

    // Verify /clear was written to orchestrator (proves first cycle started)
    const clearWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('/clear'));
    assert.ok(clearWrite, 'engine should send /clear to orchestrator on first cycle');

    // No session:output was emitted -- proves this is purely the deferred start, not prompt detection
  });

  // ---------- Test 3: subsequent cycle triggers via prompt completion (existing behavior) ----------

  it('subsequent cycle triggers via worker prompt completion detection', async () => {
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

  // ---------- Test 3b: markerless worker completion via idle prompt (❯) ----------

  it('worker completion detected via idle prompt (❯) when no completion marker present', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Emit worker output with NO completion marker, just the idle prompt ❯
    await emitOutput(bus, 'worker', markerlessOutput('quick answer with no marker'));

    // Advance past baseDelay (debounce) + idleDelay (completion detection)
    timer.advance(50);  // debounce fires, capture runs, crunched=true via ❯ detection
    timer.advance(100); // idle fires -> onPromptComplete -> state changes

    // Engine should transition past idle into clearing-orchestrator
    assert.equal(engine.state, 'clearing-orchestrator',
      'engine should detect worker completion via ❯ prompt and start cycle');
  });

  // ---------- Test 3c: idle timer starvation from invisible PTY data ----------

  it('worker completion fires despite periodic invisible PTY data after marker', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Worker completes with marker
    await emitOutput(bus, 'worker', completionOutput('done'));
    timer.advance(50); // debounce fires, crunched=true

    // Simulate cursor blinks that don't change visible content
    for (let i = 0; i < 12; i++) {
      bus.emit('session:output', 'worker', '\x1b[H');
      await flush();
      timer.advance(100);
    }
    // 1250ms total. idleDelay=100 in test config, so should have triggered.

    assert.equal(engine.state, 'clearing-orchestrator',
      'engine should detect worker completion despite invisible PTY data');
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

    // Step 2: Orchestrator processes /clear -- poll detects (no content)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete (prompt text sent)
    timer.advance(50);   // delayed Enter fires -> waiting-response

    // Engine should have sent prompt to orchestrator
    const promptWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('## Task'));
    assert.ok(promptWrite, 'engine should send prompt to orchestrator');

    // Step 3: Orchestrator responds with directive
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: npm test'));
    timer.advance(1000); // response poll fires, finds COMMAND directive

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

    // Orchestrator clears -- poll detects (no content)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter after prompt

    // Engine sends prompt, orchestrator responds with ESCALATE
    await emitOutput(bus, 'orchestrator', directiveOutput('ESCALATE: task is complete'));
    timer.advance(1000); // response poll fires, finds ESCALATE directive

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

    // Clear -- poll detects (no content)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter after prompt

    // Orchestrator responds with WAIT: 5
    await emitOutput(bus, 'orchestrator', directiveOutput('WAIT: 5'));
    timer.advance(1000); // response poll fires, finds WAIT directive

    assert.equal(engine.state, 'waiting', 'should be in waiting state after WAIT directive');

    // Advance 4 seconds -- still waiting
    timer.advance(4000);
    assert.equal(engine.state, 'waiting', 'should still be waiting after 4s');

    // Advance remaining 1 second -- WAIT timer expires.
    // Worker screen still has completion marker from initial cycle setup,
    // so the deferred worker-already-idle check fires and starts a new cycle.
    timer.advance(1000);
    // The deferred check (setTimeout 0) fires within this advance
    assert.equal(engine.state, 'clearing-orchestrator',
      'should detect worker already idle after WAIT expires and start new cycle');
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

    // Clear -- poll detects (no content)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter after prompt

    // Orchestrator responds with SELECT: 3 (needs 2 arrow-downs then Enter)
    await emitOutput(bus, 'orchestrator', directiveOutput('SELECT: 3'));
    timer.advance(1000); // response poll fires, finds SELECT directive

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
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50); // poll + settle + Enter
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo 1'));
    timer.advance(1000); // response poll fires, finds COMMAND directive

    assert.equal(engine.state, 'idle', 'should be idle after cycle 1');

    // Complete cycle 2
    await emitOutput(bus, 'worker', completionOutput('cycle 2'));
    timer.advance(50); timer.advance(100);
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50); // poll + settle + Enter
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo 2'));
    timer.advance(1000); // response poll fires, finds COMMAND directive

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
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50); // poll + settle + Enter
      await emitOutput(bus, 'orchestrator', directiveOutput(`COMMAND: echo ${i}`));
      timer.advance(1000); // response poll fires, finds COMMAND directive
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
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50); // poll + settle + Enter

    // Orchestrator responds with unparseable text (includes completion marker)
    await emitOutput(bus, 'orchestrator', directiveOutput('I think we should run tests'));
    timer.advance(1000); // response poll fires, finds completion marker -> onResponseReady

    // onResponseReady sends retry prompt text, then delayed Enter
    timer.advance(50); // delayed Enter for retry prompt

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
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50); // poll + settle + Enter

    // First unparseable response -> triggers retry
    await emitOutput(bus, 'orchestrator', directiveOutput('I think we should run tests'));
    timer.advance(1000); // response poll fires, finds completion marker -> onResponseReady

    // Retry prompt has delayed Enter
    timer.advance(50);
    assert.equal(engine.state, 'waiting-response', 'should be waiting for retry response');

    // Second unparseable response -> should ESCALATE
    await emitOutput(bus, 'orchestrator', directiveOutput('Hmm let me think about that'));
    timer.advance(1000); // response poll fires, finds completion marker -> onResponseReady

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

  // ---------- Test 19: /clear with (no content) detected via poll ----------

  it('/clear with (no content) response detected via poll completes clearing', async () => {
    // Use longer idleDelay to prove poll-based detection works independently
    const longIdleConfig = { ...config, idleDelay: 2000 };
    engine = new AutomationEngine(longIdleConfig, mockSessionManager, bus);

    engine.start();

    // Worker goes idle (use first-cycle deferred timer to avoid idleDelay dependency)
    timer.advance(1); // deferred start -> onWorkerIdle

    assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator');

    // /clear produces "(no content)" -- the actual Claude Code response
    await emitOutput(bus, 'orchestrator', clearOutput());

    // Poll fires after 1000ms, reads screen text, finds "(no content)"
    timer.advance(1000); // poll fires
    // 500ms settling delay -> onClearComplete
    timer.advance(500);

    assert.notEqual(engine.state, 'clearing-orchestrator',
      'should transition past clearing-orchestrator on (no content)');
    assert.equal(engine.state, 'prompting-orchestrator',
      'should be in prompting-orchestrator (prompt text sent, Enter pending)');

    // Delayed Enter fires after baseDelay
    timer.advance(50);
    assert.equal(engine.state, 'waiting-response',
      'should transition to waiting-response after delayed Enter');

    // Verify prompt was sent
    const promptWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('## Task'));
    assert.ok(promptWrite, 'engine should send prompt after poll-based clear detection');
  });

  // ---------- Test 20: output without (no content) does NOT complete clearing ----------

  it('clearing poll does not complete when screen has no (no content) text', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);

    engine.start();

    // Use first-cycle deferred timer to enter clearing-orchestrator
    timer.advance(1);

    assert.equal(engine.state, 'clearing-orchestrator');

    // /clear response includes spinner but NOT "(no content)"
    await emitOutput(bus, 'orchestrator', 'Conversation cleared.\r\n\u273B\r\n');

    // Poll fires after 1000ms, doesn't find "(no content)" -- still clearing
    timer.advance(1000);
    assert.equal(engine.state, 'clearing-orchestrator',
      'should still be clearing when screen has no (no content)');

    // Now emit "(no content)" output
    await emitOutput(bus, 'orchestrator', '  \u23BF  (no content)\r\n');

    // Next poll fires after 1000ms, finds "(no content)"
    timer.advance(1000);
    // 500ms settling delay -> onClearComplete
    timer.advance(500);

    assert.equal(engine.state, 'prompting-orchestrator',
      'should transition to prompting-orchestrator after (no content) appears');
  });

  // ---------- Test 21: full cycle with delayed (no content) appearance ----------

  it('full cycle completes when (no content) appears after initial /clear output', async () => {

    engine = new AutomationEngine(config, mockSessionManager, bus);
    const cycleEvents: Array<{ cycle: number; action: string }> = [];
    bus.on('automation:cycle-complete', (cycle, action) => {
      cycleEvents.push({ cycle, action });
    });

    engine.start();

    // Step 1: Worker goes idle (with normal completion marker)
    await emitOutput(bus, 'worker', completionOutput('$ npm test\nall tests passed'));
    timer.advance(50);  // debounce fires capture
    timer.advance(100); // idle fires onPromptComplete

    assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator');

    // Verify /clear was sent
    const clearWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('/clear'));
    assert.ok(clearWrite, 'engine should send /clear to orchestrator');

    // Step 2: /clear initially produces text without (no content)
    await emitOutput(bus, 'orchestrator', 'Conversation cleared.\r\n');
    timer.advance(1000); // poll fires, doesn't find "(no content)"
    assert.equal(engine.state, 'clearing-orchestrator', 'should still be clearing without (no content)');

    // (no content) appears
    await emitOutput(bus, 'orchestrator', '  \u23BF  (no content)\r\n');
    timer.advance(1000); // next poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter fires -> waiting-response

    // Engine should have moved past clearing-orchestrator
    assert.notEqual(engine.state, 'clearing-orchestrator',
      'should transition past clearing-orchestrator after (no content) appears');

    // Verify prompt was sent to orchestrator
    const promptWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('## Task'));
    assert.ok(promptWrite, 'engine should send prompt to orchestrator after /clear');

    // Step 3: Orchestrator responds with directive (normal completion marker)
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: npm test'));
    timer.advance(1000); // response poll fires, finds COMMAND directive

    // Verify command was written to worker
    const cmdWrite = writes.find(w => w.name === 'worker' && w.data.includes('npm test'));
    assert.ok(cmdWrite, 'engine should write command to worker');

    // Verify cycle completed
    assert.equal(cycleEvents.length, 1, 'should emit one cycle-complete event');
    assert.equal(cycleEvents[0].cycle, 1, 'should be cycle 1');
    assert.ok(cycleEvents[0].action.includes('COMMAND'), 'action should mention COMMAND');

    // Engine should be back in idle, ready for next cycle
    assert.equal(engine.state, 'idle', 'should return to idle after full cycle');
  });

  // ---------- Test 22: (no content) split across PTY chunks (emulator reassembles) ----------

  it('/clear with (no content) split across two PTY chunks detected by poll on emulator screen', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);

    engine.start();

    // Worker goes idle (use first-cycle deferred timer)
    timer.advance(1);

    assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator');

    // /clear produces "(no content)" split across two PTY chunks
    // The emulator processes both chunks and assembles the screen text
    await emitOutput(bus, 'orchestrator', '> /clear\r\n\r\n  \u23BF  (no ');
    await flush();
    await emitOutput(bus, 'orchestrator', 'content)\r\n');
    await flush();

    // Poll fires after 1000ms, reads assembled screen text from emulator
    timer.advance(1000);
    // 500ms settling delay -> onClearComplete
    timer.advance(500);

    assert.notEqual(engine.state, 'clearing-orchestrator',
      'should transition past clearing-orchestrator when emulator has assembled (no content)');
    assert.equal(engine.state, 'prompting-orchestrator',
      'should be in prompting-orchestrator (prompt text sent, Enter pending)');

    // Delayed Enter fires after baseDelay
    timer.advance(50);
    assert.equal(engine.state, 'waiting-response',
      'should transition to waiting-response after delayed Enter');
  });

  // ---------- Test 24: bare ✻ idle prompt does not block response detection ----------

  it('orchestrator response with bare ✻ idle prompt does not stall at waiting-response', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const cycleEvents: Array<{ cycle: number; action: string }> = [];
    bus.on('automation:cycle-complete', (cycle, action) => {
      cycleEvents.push({ cycle, action });
    });

    engine.start();

    // Worker goes idle
    await emitOutput(bus, 'worker', completionOutput('$ npm test\nall tests passed'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle -> onWorkerIdle -> clearing-orchestrator

    // Orchestrator clears -- poll detects (no content)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter -> waiting-response

    assert.equal(engine.state, 'waiting-response', 'should be waiting for orchestrator response');

    // Orchestrator responds with COMMAND directive + completion marker + bare ✻ idle prompt.
    // In production, Claude Code's TUI shows ✻ as the idle prompt indicator after completing.
    // This bare ✻ must NOT trigger the subagent spinner guard.
    await emitOutput(bus, 'orchestrator', '● COMMAND: npm test\r\n\u273B Crunched for 5s\r\n\u273B\r\n');
    timer.advance(1000); // response poll fires, finds COMMAND directive

    // Engine should have parsed the COMMAND and sent it to the worker
    const cmdWrite = writes.find(w => w.name === 'worker' && w.data.includes('npm test'));
    assert.ok(cmdWrite, 'engine should write COMMAND to worker (bare ✻ must not block response detection)');
    assert.equal(engine.state, 'idle', 'should return to idle after executing COMMAND');
    assert.equal(cycleEvents.length, 1, 'should complete one cycle');
  });

  // ---------- Test 25: waiting-response poll detects directive without completion marker ----------

  it('waiting-response poll: engine detects response via directive polling when completion marker is absent', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const cycleEvents: Array<{ cycle: number; action: string }> = [];
    bus.on('automation:cycle-complete', (cycle, action) => {
      cycleEvents.push({ cycle, action });
    });

    engine.start();

    // Worker goes idle (first cycle via deferred timer)
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator');

    // Orchestrator clears -- poll detects (no content)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter -> waiting-response

    assert.equal(engine.state, 'waiting-response', 'should be waiting for response');

    // Orchestrator responds with COMMAND but NO completion marker.
    // With poll-based detection, the poll reads screen text and finds
    // the COMMAND directive directly -- no marker needed.
    await emitOutput(bus, 'orchestrator', '● COMMAND: npm test\r\n');

    // Advance 1000ms to fire the response poll
    timer.advance(1000); // poll fires, finds COMMAND directive

    // Engine should have parsed COMMAND and sent it to worker
    const cmdWrite = writes.find(w => w.name === 'worker' && w.data.includes('npm test'));
    assert.ok(cmdWrite, 'poll should detect COMMAND directive, sent to worker');
    assert.equal(engine.state, 'idle', 'should return to idle after poll-based response detection');
    assert.equal(cycleEvents.length, 1, 'should complete one cycle');
  });

  // ---------- Test 26: response poll runs indefinitely until directive appears ----------

  it('response poll runs indefinitely when no directive appears, then completes when it does', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const cycleEvents: Array<{ cycle: number; action: string }> = [];
    bus.on('automation:cycle-complete', (cycle, action) => {
      cycleEvents.push({ cycle, action });
    });

    engine.start();

    // Worker goes idle (first cycle via deferred timer)
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator');

    // Orchestrator clears -- poll detects (no content)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter -> waiting-response

    assert.equal(engine.state, 'waiting-response', 'should be waiting for response');

    // Orchestrator has no parseable directive yet (e.g., "thinking..." text)
    await emitOutput(bus, 'orchestrator', 'Thinking about the task...\r\n');

    // Advance 5000ms (5 polls fire, none find a directive) -- still waiting
    timer.advance(5000);
    assert.equal(engine.state, 'waiting-response',
      'should still be waiting-response after 5s of polling without a directive');

    // Now orchestrator responds with a directive
    await emitOutput(bus, 'orchestrator', '● COMMAND: echo hello\r\n');

    // Next poll fires after 1000ms, finds the directive
    timer.advance(1000);

    // Engine should have written command to worker and returned to idle
    const cmdWrite = writes.find(w => w.name === 'worker' && w.data.includes('echo hello'));
    assert.ok(cmdWrite, 'poll should detect COMMAND directive after extended wait');
    assert.equal(engine.state, 'idle', 'should return to idle after directive found');
    assert.equal(cycleEvents.length, 1, 'should complete one cycle');
  });

  // ---------- Test 23: clearing poll runs indefinitely until (no content) appears ----------

  it('clearing poll runs indefinitely when (no content) never appears, then completes when it does', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);

    engine.start();

    // Worker goes idle (first cycle triggers immediately via deferred timer)
    timer.advance(1);

    assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator');

    // Do NOT emit any orchestrator output -- simulate delayed /clear response
    // Poll runs every 1s but never finds "(no content)"

    // Advance 5 seconds (5 polls fire, none find the pattern)
    timer.advance(5000);
    assert.equal(engine.state, 'clearing-orchestrator',
      'should still be clearing after 5s of polling without (no content)');

    // Now emit "(no content)" output
    await emitOutput(bus, 'orchestrator', clearOutput());

    // Next poll fires after 1000ms, finds "(no content)"
    timer.advance(1000);
    // 500ms settling delay -> onClearComplete
    timer.advance(500);

    assert.equal(engine.state, 'prompting-orchestrator',
      'should transition to prompting-orchestrator after (no content) finally appears');

    // Delayed Enter fires after baseDelay
    timer.advance(50);
    assert.equal(engine.state, 'waiting-response',
      'should transition to waiting-response after delayed Enter');

    // Verify prompt was sent to orchestrator
    const promptWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('## Task'));
    assert.ok(promptWrite, 'engine should send prompt after poll detects (no content)');
  });

  // ---------- Test 23: clear poll detects "(no content)" from raw buffer even when emulator returns empty ----------

  it('clear poll detects "(no content)" from raw data buffer, not emulator screen text', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Step 1: Trigger first cycle (deferred timer fires)
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator');

    // Step 2: Emit orchestrator output WITHOUT flushing microtasks.
    // This means the emulator's async write() hasn't completed, so
    // getScreenText() would return empty. But the raw buffer should
    // accumulate the data synchronously.
    bus.emit('session:output', 'orchestrator', clearOutput());
    // DO NOT flush -- emulator hasn't processed the data yet

    // Step 3: Poll fires at 1000ms -- should detect "(no content)" from buffer
    // (NOT from emulator, which hasn't processed the write yet)
    timer.advance(1000);

    // Step 4: 500ms settling delay -> onClearComplete
    timer.advance(500);

    assert.equal(engine.state, 'prompting-orchestrator',
      'should transition to prompting-orchestrator using buffer-based clear detection');

    // Step 5: Delayed Enter fires after baseDelay
    timer.advance(50);
    assert.equal(engine.state, 'waiting-response',
      'should transition to waiting-response after delayed Enter');
  });

  // ---------- Test 24: clearingBuffer is reset on /clear send and on clear completion ----------

  it('clearingBuffer is reset when /clear is sent and when clear completes', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // First cycle
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator');

    // Emit clear response
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll detects it
    timer.advance(500);  // settling delay -> onClearComplete

    assert.equal(engine.state, 'prompting-orchestrator');

    // Complete the full cycle to get back to clearing-orchestrator
    timer.advance(50); // delayed Enter -> waiting-response

    // Send directive response
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo hello'));
    timer.advance(1000); // response poll fires

    // Now engine is idle, trigger another cycle via worker output
    await emitOutput(bus, 'worker', completionOutput('echo hello output'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle detection

    assert.equal(engine.state, 'clearing-orchestrator',
      'should be clearing orchestrator for second cycle');

    // Emit a DIFFERENT clear response -- the buffer should only have this new data
    // (buffer was reset before sending /clear)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll detects it
    timer.advance(500);  // settling delay

    assert.equal(engine.state, 'prompting-orchestrator',
      'second cycle should also detect clear from fresh buffer');
  });

  // ---------- Test 25: ANSI escape codes in raw PTY data don't prevent "(no content)" detection ----------

  it('ANSI escape codes in raw PTY data do not prevent "(no content)" detection', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Trigger first cycle
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator');

    // Emit clear response wrapped in ANSI escape codes (common in real PTY output)
    // Don't flush -- rely on buffer, not emulator
    const ansiWrappedClear = '\x1b[2m> /clear\x1b[0m\r\n\r\n  \x1b[36m\u23BF\x1b[0m  (no content)\r\n';
    bus.emit('session:output', 'orchestrator', ansiWrappedClear);

    // Poll fires at 1000ms -- should detect "(no content)" after stripping ANSI codes from buffer
    timer.advance(1000);
    // 500ms settling delay -> onClearComplete
    timer.advance(500);

    assert.equal(engine.state, 'prompting-orchestrator',
      'should detect (no content) even with ANSI escape codes in raw PTY data');
  });

  // ---------- Test 27: echoed worker screen with ● and ✻ does NOT trigger false completion ----------

  it('echoed worker screen with indented ● and ✻ does not trigger false completion', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (err) => errors.push(err));

    engine.start();

    // Worker goes idle (first cycle via deferred timer)
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator');

    // Orchestrator clears
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter -> waiting-response

    assert.equal(engine.state, 'waiting-response', 'should be waiting for response');

    // Emit orchestrator output simulating the prompt echo.
    // The echo contains worker screen text with INDENTED ● lines and ✻ completion marker.
    // These must NOT be detected as actual orchestrator responses.
    const echoedPrompt = [
      '  ## Worker Screen\r\n',
      '    ● I analyzed the code and found the issue\r\n',
      '    ● Here is my recommendation:\r\n',
      '    \u273B Crunched for 1m 22s\r\n',
    ].join('');
    await emitOutput(bus, 'orchestrator', echoedPrompt);

    // Poll fires — must NOT trigger false completion/retry
    timer.advance(1000);
    assert.equal(engine.state, 'waiting-response',
      'indented ● and ✻ from echoed worker screen must not trigger false completion');

    // Two more polls — still waiting
    timer.advance(2000);
    assert.equal(engine.state, 'waiting-response',
      'should still be waiting after multiple polls with only echoed content');
  });

  // ---------- Test 28: real column-0 response detected after echoed indented content ----------

  it('real column-0 response detected after echoed indented content', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const cycleEvents: Array<{ cycle: number; action: string }> = [];
    bus.on('automation:cycle-complete', (cycle, action) => {
      cycleEvents.push({ cycle, action });
    });

    engine.start();

    // Worker goes idle (first cycle via deferred timer)
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator');

    // Orchestrator clears
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter -> waiting-response

    assert.equal(engine.state, 'waiting-response');

    // Emit echoed prompt with indented ● and ✻ (should be ignored)
    const echoedPrompt = [
      '  ## Worker Screen\r\n',
      '    ● Some worker response text\r\n',
      '    \u273B Crunched for 4m 50s\r\n',
    ].join('');
    await emitOutput(bus, 'orchestrator', echoedPrompt);

    // Poll fires — echoed content ignored
    timer.advance(1000);
    assert.equal(engine.state, 'waiting-response', 'echoed content should be ignored');

    // Now emit REAL orchestrator response at column 0
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo hello'));
    timer.advance(1000); // poll finds the real directive

    // Engine should have executed the command
    const cmdWrite = writes.find(w => w.name === 'worker' && w.data.includes('echo hello'));
    assert.ok(cmdWrite, 'real column-0 directive should be detected after echoed content');
    assert.equal(engine.state, 'idle', 'should return to idle after real response');
    assert.equal(cycleEvents.length, 1, 'should complete one cycle');
  });

  // ---------- Test: DONE directive stops engine ----------

  it('DONE directive stops engine and emits automation:done', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const doneSummaries: string[] = [];
    bus.on('automation:done', (summary) => {
      doneSummaries.push(summary);
    });

    engine.start();

    // Worker goes idle
    await emitOutput(bus, 'worker', completionOutput('task output'));
    timer.advance(50);
    timer.advance(100);

    // Orchestrator clears -- poll detects (no content)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter after prompt

    // Engine sends prompt, orchestrator responds with DONE
    await emitOutput(bus, 'orchestrator', directiveOutput('DONE: Task completed successfully'));
    timer.advance(1000); // response poll fires, finds DONE directive

    assert.equal(engine.state, 'stopped', 'DONE should stop the engine (not pause)');
    assert.equal(doneSummaries.length, 1, 'should emit one automation:done event');
    assert.ok(doneSummaries[0].includes('Task completed successfully'), 'done event should contain the summary');
  });

  // ---------- Test: ESCALATE still pauses (not stops) ----------

  it('ESCALATE still pauses engine after DONE is added (unchanged behavior)', async () => {
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
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000);
    timer.advance(500);
    timer.advance(50);

    // Orchestrator responds with ESCALATE
    await emitOutput(bus, 'orchestrator', directiveOutput('ESCALATE: I am blocked'));
    timer.advance(1000);

    assert.equal(engine.state, 'paused', 'ESCALATE should still pause (not stop)');
    assert.equal(escalations.length, 1, 'should emit escalation event');
  });

  // ---------- Test A: onWorkerIdle is ignored when engine is not in idle state (false idle guard) ----------

  it('onWorkerIdle is ignored when engine is not in idle state (false idle guard)', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Step 1: Trigger first cycle via deferred timer -> clearing-orchestrator
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator');

    // Step 2: Complete clear and get to waiting-response
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter -> waiting-response

    assert.equal(engine.state, 'waiting-response', 'should be waiting for orchestrator response');

    // Step 3: Worker emits output with completion marker (simulating subagent pause).
    // In buggy code, this triggers onWorkerIdle and corrupts the current cycle.
    await emitOutput(bus, 'worker', completionOutput('subagent paused'));

    // Advance past debounce (50) + idle (100) -- triggers onPromptComplete on worker monitor
    timer.advance(50);  // debounce fires, capture runs, crunched=true
    timer.advance(100); // idle fires -> onPromptComplete -> onWorkerIdle

    // Assert: engine state must STILL be waiting-response (not clearing-orchestrator)
    assert.equal(engine.state, 'waiting-response',
      'onWorkerIdle must be ignored when engine is in waiting-response state (false idle guard)');

    // Step 4: Complete the cycle normally -- orchestrator responds with directive
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo done'));
    timer.advance(1000); // response poll fires, finds COMMAND directive

    // Engine should complete normally
    assert.equal(engine.state, 'idle', 'engine should return to idle after completing cycle');
    const cmdWrite = writes.find(w => w.name === 'worker' && w.data.includes('echo done'));
    assert.ok(cmdWrite, 'command should be written to worker');
  });

  // ---------- Test B: WAIT directive recovery when worker finishes during wait period ----------

  it('WAIT directive recovery when worker finishes during wait period', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Complete first cycle up to WAIT: 2
    timer.advance(1); // deferred start -> clearing-orchestrator
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter -> waiting-response

    // Orchestrator responds with WAIT: 2
    await emitOutput(bus, 'orchestrator', directiveOutput('WAIT: 2'));
    timer.advance(1000); // response poll fires, finds WAIT directive

    assert.equal(engine.state, 'waiting', 'should be in waiting state');

    // Worker finishes during wait -- emit completion output
    await emitOutput(bus, 'worker', completionOutput('task done'));

    // Advance past debounce (50ms) so worker screen captures the completion
    timer.advance(50);

    // Advance remaining time to expire WAIT timer (total 2000ms - we already used ~50ms from the 2000ms WAIT period)
    // The WAIT timer fires at 2000ms from when it was set. We've advanced 50ms since then.
    timer.advance(1950);

    // After WAIT expires, engine should detect worker is already idle and start new cycle.
    // In buggy code, engine sits at idle forever because no new onPromptComplete fires.
    // Give a short advance for the deferred check to fire.
    timer.advance(1);

    assert.equal(engine.state, 'clearing-orchestrator',
      'engine should detect worker already idle after WAIT expires and start new cycle (not stuck at idle)');

    // Verify /clear was sent (proves new cycle started)
    const clearWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('/clear'));
    assert.ok(clearWrites.length >= 2, 'should send /clear for both cycles');
  });

  // ---------- Test C: WAIT normal case -- worker still busy after wait expires ----------

  it('WAIT directive normal case -- worker still busy after wait expires', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Complete first cycle up to WAIT: 2
    timer.advance(1); // deferred start -> clearing-orchestrator
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter -> waiting-response

    // Orchestrator responds with WAIT: 2
    await emitOutput(bus, 'orchestrator', directiveOutput('WAIT: 2'));
    timer.advance(1000); // response poll fires, finds WAIT directive

    assert.equal(engine.state, 'waiting', 'should be in waiting state');

    // Do NOT emit any worker output during wait -- worker is still busy

    // Advance 2000ms to expire WAIT timer
    timer.advance(2000);

    // Engine should go to idle and wait for worker to complete
    assert.equal(engine.state, 'idle', 'should return to idle after WAIT expires with worker still busy');

    // Now emit worker completion -- engine should start next cycle
    await emitOutput(bus, 'worker', completionOutput('worker finished'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle -> onPromptComplete

    assert.equal(engine.state, 'clearing-orchestrator',
      'should start new cycle when worker completes after WAIT expired');
  });

  // ---------- Stagnation detection tests ----------

  it('stagnation detection: engine enters consultation after worker output stagnation', async () => {
    // Use short stagnation delay for testing
    const stagnationConfig = { ...config, stagnationDelay: 200 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    // Complete first cycle to get engine back to idle
    timer.advance(1); // deferred start -> clearing-orchestrator
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onClearComplete
    timer.advance(50);   // delayed Enter -> waiting-response

    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
    timer.advance(1000); // response poll fires, finds COMMAND directive

    assert.equal(engine.state, 'idle', 'should be idle after first cycle');

    // Do NOT emit any worker output -- let stagnation timer fire
    timer.advance(200); // stagnation timer fires

    // Engine should have entered consultation flow and be clearing orchestrator
    assert.equal(engine.state, 'clearing-orchestrator',
      'should enter clearing-orchestrator after stagnation timer fires');

    // Verify /clear was written (proves consultation flow started)
    const clearWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('/clear'));
    assert.ok(clearWrites.length >= 2, 'should send /clear for consultation (second /clear)');
  });

  it('completion marker fast path: completion marker triggers immediate cycle, not consultation', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    // Complete first cycle to get engine back to idle
    timer.advance(1); // deferred start -> clearing-orchestrator
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
    timer.advance(1000);

    assert.equal(engine.state, 'idle', 'should be idle after first cycle');

    // Worker emits output WITH completion marker (fast path)
    await emitOutput(bus, 'worker', completionOutput('task done'));
    timer.advance(50);  // debounce fires
    timer.advance(100); // idle fires -> onPromptComplete -> onWorkerIdle

    // Engine should enter clearing-orchestrator via normal cycle (not consultation)
    assert.equal(engine.state, 'clearing-orchestrator',
      'completion marker should trigger normal cycle, not consultation');

    // Complete clear and verify a directive prompt (not consultation prompt) was sent
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500);

    // Check that the prompt sent is a directive prompt (contains "## Your Response")
    // not a consultation prompt (which would contain "## Question")
    const promptWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('## Your Response'));
    assert.ok(promptWrites.length > 0, 'should send directive prompt (not consultation prompt) on fast path');
  });

  it('stagnation timer resets on worker output', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    // Complete first cycle to get engine back to idle
    timer.advance(1); // deferred start
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
    timer.advance(1000);

    assert.equal(engine.state, 'idle', 'should be idle after first cycle');

    // Advance partway through stagnation delay (150 of 200ms)
    timer.advance(150);
    assert.equal(engine.state, 'idle', 'should still be idle before stagnation fires');

    // Emit non-completion worker output (resets stagnation timer)
    await emitOutput(bus, 'worker', 'Processing...\r\n');

    // Advance same partial amount again (150ms from reset)
    timer.advance(150);
    assert.equal(engine.state, 'idle',
      'should still be idle because stagnation timer was reset by worker output');

    // Advance remaining time to fire the reset stagnation timer (50ms more = 200ms total from reset)
    timer.advance(50);

    // Now stagnation should fire
    assert.equal(engine.state, 'clearing-orchestrator',
      'stagnation timer should fire after full delay from last worker output');
  });

  it('consultation prompt sent to orchestrator after stagnation', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    // Complete first cycle to get engine back to idle
    timer.advance(1);
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
    timer.advance(1000);

    assert.equal(engine.state, 'idle', 'should be idle after first cycle');

    // Let stagnation fire
    timer.advance(200);
    assert.equal(engine.state, 'clearing-orchestrator', 'consultation clearing started');

    // Complete clear
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires, finds "(no content)"
    timer.advance(500);  // settling delay -> onConsultationClearComplete

    // Consultation prompt should be sent (contains "YES" and "NO", not "COMMAND")
    const consultationWrites = writes.filter(
      w => w.name === 'orchestrator' && w.data.includes('YES') && w.data.includes('NO')
    );
    assert.ok(consultationWrites.length > 0,
      'should send consultation prompt containing YES and NO to orchestrator');

    // Verify it does NOT contain directive instructions
    const directiveWrites = writes.filter(
      w => w.name === 'orchestrator' && w.data.includes('## Your Response')
    );
    // The directive prompt from cycle 1 will exist, but after the consultation clear,
    // we should see a consultation prompt instead. Check the last prompt write.
    const lastPromptWrite = writes
      .filter(w => w.name === 'orchestrator' && (w.data.includes('## Question') || w.data.includes('## Your Response')))
      .pop();
    assert.ok(lastPromptWrite?.data.includes('## Question'),
      'last prompt should be consultation (## Question), not directive (## Your Response)');
  });

  // ---------- Consultation YES/NO response handling tests ----------

  /**
   * Helper: drive engine through first cycle and into consultation waiting state.
   * Returns the engine in 'waiting-consultation' state, ready for YES/NO response.
   */
  async function driveToConsultationWaiting(
    engineInst: AutomationEngine,
    busInst: EventBus,
    timerInst: ManualTimer,
  ): Promise<void> {
    // Complete first cycle to get engine to idle
    timerInst.advance(1); // deferred start -> clearing-orchestrator
    await emitOutput(busInst, 'orchestrator', clearOutput());
    timerInst.advance(1000); timerInst.advance(500); timerInst.advance(50);
    await emitOutput(busInst, 'orchestrator', directiveOutput('COMMAND: echo test'));
    timerInst.advance(1000);
    // Engine is now idle

    // Let stagnation fire (stagnationDelay=200 in test config)
    timerInst.advance(200);
    // Now in clearing-orchestrator (consultation mode)

    // Complete clear
    await emitOutput(busInst, 'orchestrator', clearOutput());
    timerInst.advance(1000); // poll fires
    timerInst.advance(500);  // settling delay -> onConsultationClearComplete

    // Consultation prompt sent, delayed Enter
    timerInst.advance(50); // baseDelay -> Enter sent -> waiting-consultation
  }

  it('consultation YES: orchestrator says YES -> engine starts normal directive cycle', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    const cycleEvents: Array<{ cycle: number; action: string }> = [];
    bus.on('automation:cycle-complete', (cycle: number, action: string) => {
      cycleEvents.push({ cycle, action });
    });
    engine.start();

    await driveToConsultationWaiting(engine, bus, timer);
    assert.equal(engine.state, 'waiting-consultation', 'should be waiting for consultation response');

    // Orchestrator responds YES
    await emitOutput(bus, 'orchestrator', directiveOutput('YES'));
    timer.advance(1000); // response poll fires, finds YES directive

    // YES should trigger normal directive cycle: idle -> onWorkerIdle -> capturing-worker -> clearing-orchestrator
    assert.equal(engine.state, 'clearing-orchestrator',
      'YES response should trigger normal directive cycle (clearing-orchestrator)');

    // Complete the directive cycle to verify it works end-to-end
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo done'));
    timer.advance(1000);

    assert.equal(engine.state, 'idle', 'should return to idle after directive cycle completes');
    assert.equal(cycleEvents.length, 1, 'should have completed one additional cycle after YES');
  });

  it('consultation NO: orchestrator says NO -> engine waits then re-checks', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    await driveToConsultationWaiting(engine, bus, timer);
    assert.equal(engine.state, 'waiting-consultation', 'should be waiting for consultation response');

    // Orchestrator responds NO
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000); // response poll fires, finds NO directive

    // NO should transition to consultation-wait
    assert.equal(engine.state, 'consultation-wait',
      'NO response should transition to consultation-wait state');

    // After consultationWaitDelay (300ms), engine re-checks and re-enters consultation
    timer.advance(300); // consultation wait timer fires

    // Engine should re-enter consultation flow (clearing-orchestrator in consultation mode)
    assert.equal(engine.state, 'clearing-orchestrator',
      'should re-enter clearing-orchestrator for re-consultation after NO wait');
  });

  it('consultation NO then completion marker during wait: fast path kicks in', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    await driveToConsultationWaiting(engine, bus, timer);
    assert.equal(engine.state, 'waiting-consultation');

    // Orchestrator responds NO
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000); // response poll fires

    assert.equal(engine.state, 'consultation-wait', 'should be in consultation-wait');

    // Worker emits completion marker during consultation-wait
    await emitOutput(bus, 'worker', completionOutput('task actually done'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle fires -> onPromptComplete -> completion detected

    // Completion marker should cancel consultation-wait and start normal cycle
    assert.notEqual(engine.state, 'consultation-wait',
      'completion marker should exit consultation-wait');
    // Engine should be in clearing-orchestrator (normal cycle, not consultation)
    assert.equal(engine.state, 'clearing-orchestrator',
      'completion marker during NO wait should trigger normal cycle');

    // Verify it's a directive prompt (not consultation)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500);

    const lastPromptWrite = writes
      .filter(w => w.name === 'orchestrator' && (w.data.includes('## Question') || w.data.includes('## Your Response')))
      .pop();
    assert.ok(lastPromptWrite?.data.includes('## Your Response'),
      'after completion during NO wait, should send directive prompt (not consultation)');
  });

  it('consultation NO-NO-YES: multiple re-checks before YES', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    await driveToConsultationWaiting(engine, bus, timer);
    assert.equal(engine.state, 'waiting-consultation');

    // First NO
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000); // response poll fires
    assert.equal(engine.state, 'consultation-wait', 'first NO -> consultation-wait');

    // Wait expires -> re-consultation
    timer.advance(300);
    assert.equal(engine.state, 'clearing-orchestrator', 'should re-enter consultation clearing');

    // Complete re-consultation clear + prompt
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    assert.equal(engine.state, 'waiting-consultation', 'should be waiting for second consultation');

    // Second NO
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000);
    assert.equal(engine.state, 'consultation-wait', 'second NO -> consultation-wait');

    // Wait expires -> re-consultation again
    timer.advance(300);
    assert.equal(engine.state, 'clearing-orchestrator', 'should re-enter consultation clearing again');

    // Complete re-consultation clear + prompt
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    assert.equal(engine.state, 'waiting-consultation', 'should be waiting for third consultation');

    // Third time: YES
    await emitOutput(bus, 'orchestrator', directiveOutput('YES'));
    timer.advance(1000);

    // YES should trigger normal directive cycle
    assert.equal(engine.state, 'clearing-orchestrator',
      'YES after two NOs should trigger normal directive cycle');
  });

  it('consultation unparseable response triggers retry, second failure escalates', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    const escalations: string[] = [];
    bus.on('automation:escalation', (reason: string) => {
      escalations.push(reason);
    });
    engine.start();

    await driveToConsultationWaiting(engine, bus, timer);
    assert.equal(engine.state, 'waiting-consultation');

    // Orchestrator responds with unparseable text
    await emitOutput(bus, 'orchestrator', directiveOutput('I think the worker might be done'));
    timer.advance(1000); // response poll fires

    // Engine should retry with clarifying prompt
    const retryWrites = writes.filter(
      w => w.name === 'orchestrator' && w.data.includes('YES or NO')
    );
    assert.ok(retryWrites.length >= 1, 'should send clarifying retry prompt asking for YES or NO');

    // After retry prompt, Enter is sent
    timer.advance(50); // delayed Enter
    assert.equal(engine.state, 'waiting-consultation', 'should be waiting for retry response');

    // Second unparseable response -> escalation
    await emitOutput(bus, 'orchestrator', directiveOutput('Well it depends on the context'));
    timer.advance(1000);

    assert.equal(engine.state, 'paused', 'should be paused after double consultation parse failure');
    assert.ok(escalations.length >= 1, 'should emit escalation after double failure');
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

// ---------- SettingsStore cycle_limit -> EngineConfig.maxCycles wiring ----------

describe('SettingsStore cycle_limit -> EngineConfig.maxCycles wiring', () => {
  let db: Database.Database;
  let settingsStore: SettingsStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    settingsStore = new SettingsStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('engineFactory closure injects maxCycles=50 when settingsStore has cycle_limit=50', () => {
    settingsStore.setNumber('cycle_limit', 50);

    // Simulate the engineFactory closure pattern from src/index.ts
    const engineFactory = (engineConfig: EngineConfig, engineBus: EventBus) => {
      const mergedConfig = { ...engineConfig, maxCycles: settingsStore.getNumber('cycle_limit', 100) };
      return mergedConfig;
    };

    const baseConfig: EngineConfig = {
      workerSession: 'worker',
      orchestratorSession: 'orchestrator',
      taskDescription: 'test task',
    };
    const bus = new EventBus();

    const result = engineFactory(baseConfig, bus);
    assert.equal(result.maxCycles, 50, 'maxCycles should be 50 from settingsStore');
  });

  it('engineFactory closure injects maxCycles=100 (default) when no cycle_limit set', () => {
    // Don't set cycle_limit -- settingsStore.getNumber should return default

    const engineFactory = (engineConfig: EngineConfig, engineBus: EventBus) => {
      const mergedConfig = { ...engineConfig, maxCycles: settingsStore.getNumber('cycle_limit', 100) };
      return mergedConfig;
    };

    const baseConfig: EngineConfig = {
      workerSession: 'worker',
      orchestratorSession: 'orchestrator',
      taskDescription: 'test task',
    };
    const bus = new EventBus();

    const result = engineFactory(baseConfig, bus);
    assert.equal(result.maxCycles, 100, 'maxCycles should default to 100 when cycle_limit not set');
  });
});
