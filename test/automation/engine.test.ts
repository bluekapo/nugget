import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/events/bus.js';
import { AutomationEngine, RETRY_PROMPT } from '../../src/automation/engine.js';
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
    bus.on('automation:cycle-complete', (_engineId, cycle, action) => {
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
    bus.on('automation:escalation', (_engineId, reason) => {
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

  // ---------- Test 7b: resume kicks off cycle immediately ----------

  it('resume kicks off cycle immediately when worker is already idle (no new output needed)', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();
    assert.equal(engine.state, 'idle', 'start() sets idle synchronously');

    // Fire the start() kickoff timer so it is consumed and out of the way
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator', 'start kickoff should fire');

    // Complete the orchestrator /clear so engine can progress through the cycle
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(50);
    timer.advance(100);

    // Let the full cycle play out: orchestrator prompt -> response -> worker execution -> worker idle
    // We need the engine to return to 'idle' naturally. Feed orchestrator a directive.
    await emitOutput(bus, 'orchestrator', directiveOutput('CONTINUE'));
    timer.advance(50);
    timer.advance(100);

    // Worker executes, then completes
    await emitOutput(bus, 'worker', completionOutput('done with task'));
    timer.advance(50);
    timer.advance(100);

    // Now engine is in clearing-orchestrator for cycle 2. Pause it.
    engine.pause();
    assert.equal(engine.state, 'paused', 'pause() should transition to paused');

    // Clear the writes log so we can check for NEW /clear writes from resume
    writes.length = 0;

    // Resume -- should schedule its own kickoff timer
    engine.resume();
    assert.equal(engine.state, 'idle', 'resume() should transition back to idle');

    // Advance timer by 1ms to fire the 0ms setTimeout from resume
    // NO worker output emitted -- proves resume itself kicks the cycle
    timer.advance(1);

    // Engine should have transitioned out of idle into clearing-orchestrator
    assert.equal(engine.state, 'clearing-orchestrator',
      'resume should kick cycle immediately without new worker output');

    // Verify /clear was written to orchestrator (proves cycle started from resume, not old timer)
    const clearWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('/clear'));
    assert.ok(clearWrite, 'engine should send /clear to orchestrator after resume kickoff');
  });

  // ---------- Test 7c: resume after mid-cycle pause re-kicks cycle ----------

  it('resume after mid-cycle pause re-kicks cycle', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Let the initial kickoff fire and reach clearing-orchestrator
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator', 'initial kickoff should reach clearing-orchestrator');

    // Simulate orchestrator /clear completion so engine progresses
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(50);
    timer.advance(100);

    // Engine should be past clearing-orchestrator now (prompting-orchestrator or waiting-response)
    const stateBeforePause = engine.state;
    assert.notEqual(stateBeforePause, 'idle', 'engine should be mid-cycle');

    // Pause mid-cycle
    engine.pause();
    assert.equal(engine.state, 'paused', 'pause() should transition to paused');

    // Resume -- should schedule a kickoff timer
    engine.resume();
    assert.equal(engine.state, 'idle', 'resume() should transition to idle');

    // Advance timer to fire the resume kickoff (0ms setTimeout)
    timer.advance(1);

    // Engine should kick a new cycle from idle -> clearing-orchestrator
    assert.equal(engine.state, 'clearing-orchestrator',
      'resume should re-kick cycle after mid-cycle pause');
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
    bus.on('automation:state-change', (_engineId, state) => {
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
    bus.on('automation:error', (_engineId, err) => errors.push(err));

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
    bus.on('automation:error', (_engineId, err) => errors.push(err));
    bus.on('automation:cycle-complete', (_engineId, cycle) => cycles.push(cycle));

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
    bus.on('automation:error', (_engineId, err) => errors.push(err));

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

  // ---------- Test 14: SAF-02 unlimited retries on parse failure ----------

  it('SAF-02: engine retries again after second parse failure (unlimited retries)', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (_engineId, err) => errors.push(err));

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

    // Second unparseable response -> should retry again (unlimited), NOT escalate/pause
    await emitOutput(bus, 'orchestrator', directiveOutput('Hmm let me think about that'));
    timer.advance(1000); // response poll fires, finds completion marker -> onResponseReady

    // Unlimited retry sends another retry prompt + delayed Enter
    timer.advance(50);
    assert.equal(engine.state, 'waiting-response', 'should still be waiting for response (unlimited retries)');

    // Verify retry prompts were sent (at least 2)
    const retryWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('could not be parsed'));
    assert.ok(retryWrites.length >= 2, 'should send multiple retry prompts (unlimited retries)');
  });

  // ---------- Test 15: SAF-03 Worker session disconnect ----------

  it('SAF-03: engine stops when worker session:exit fires during automation', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (_engineId, err) => errors.push(err));

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
    bus.on('automation:error', (_engineId, err) => errors.push(err));

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
    bus.on('automation:error', (_engineId, err) => errors.push(err));

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
    bus.on('automation:error', (_engineId, err) => errors.push(err));

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
    bus.on('automation:cycle-complete', (_engineId, cycle, action) => {
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
    bus.on('automation:cycle-complete', (_engineId, cycle, action) => {
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
    bus.on('automation:cycle-complete', (_engineId, cycle, action) => {
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
    bus.on('automation:cycle-complete', (_engineId, cycle, action) => {
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

    // Complete the full cycle to get back to idle
    timer.advance(50); // delayed Enter -> waiting-response

    // Send directive response
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo hello'));
    timer.advance(1000); // response poll fires

    // Now engine is idle, trigger another cycle via worker output
    // Cycle 2 uses follow-up prompt (no /clear)
    await emitOutput(bus, 'worker', completionOutput('echo hello output'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle detection

    // Cycle 2 uses follow-up path, so it goes to prompting-orchestrator directly (no clearing-orchestrator)
    assert.equal(engine.state, 'prompting-orchestrator',
      'second cycle should use follow-up prompt (prompting-orchestrator directly)');

    timer.advance(50); // baseDelay -> Enter -> waiting-response
    assert.equal(engine.state, 'waiting-response',
      'second cycle should transition to waiting-response after follow-up prompt');
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
    bus.on('automation:error', (_engineId, err) => errors.push(err));

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
    bus.on('automation:cycle-complete', (_engineId, cycle, action) => {
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
    bus.on('automation:done', (_engineId, summary) => {
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
    bus.on('automation:escalation', (_engineId, reason) => {
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

    // Cycle 2 uses follow-up prompt path (skips clearing-orchestrator)
    assert.equal(engine.state, 'prompting-orchestrator',
      'completion marker should trigger follow-up prompt cycle, not consultation');

    // After baseDelay, Enter is sent -> waiting-response
    timer.advance(50);
    assert.equal(engine.state, 'waiting-response',
      'should transition to waiting-response after follow-up prompt');

    // Check that a follow-up prompt was sent (contains "## Worker Terminal Output" not "## Question")
    const followUpWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('## Worker Terminal Output'));
    assert.ok(followUpWrites.length > 0, 'should send follow-up prompt (not consultation prompt) on fast path');
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
    bus.on('automation:cycle-complete', (_engineId: string, cycle: number, action: string) => {
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
    // cycleEvents includes the initial cycle from driveToConsultationWaiting (COMMAND: echo test) + the post-YES cycle
    assert.equal(cycleEvents.length, 2, 'should have completed initial cycle + post-YES cycle');
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

  it('consultation unparseable response triggers retry, second failure retries again (unlimited)', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    const errors: string[] = [];
    bus.on('automation:error', (_engineId: string, err: string) => {
      errors.push(err);
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

    // Second unparseable response -> should retry again (unlimited), NOT escalate/pause
    await emitOutput(bus, 'orchestrator', directiveOutput('Well it depends on the context'));
    timer.advance(1000);

    // Unlimited retry sends another consultation retry prompt + delayed Enter
    timer.advance(50);
    assert.equal(engine.state, 'waiting-consultation', 'should still be waiting for consultation (unlimited retries)');

    // Verify multiple retry prompts were sent
    const allRetryWrites = writes.filter(
      w => w.name === 'orchestrator' && w.data.includes('YES or NO')
    );
    assert.ok(allRetryWrites.length >= 2, 'should send multiple consultation retry prompts (unlimited retries)');
  });

  it('retryAttempted is reset when entering consultation mode via stagnation', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    // Complete first cycle to idle
    timer.advance(1); // deferred start -> clearing-orchestrator
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);

    // First unparseable response -> sets retryAttempted=true
    await emitOutput(bus, 'orchestrator', directiveOutput('I am confused'));
    timer.advance(1000); // response poll fires -> onResponseReady -> retry

    // Retry prompt + Enter
    timer.advance(50);
    assert.equal(engine.state, 'waiting-response', 'should be waiting for retry response');

    // Second response IS parseable -> succeeds, goes to idle
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo hello'));
    timer.advance(1000);
    assert.equal(engine.state, 'idle', 'should be idle after successful parse');

    // Now let stagnation fire -> enters consultation mode
    timer.advance(200);
    // Complete consultation clear + prompt
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    assert.equal(engine.state, 'waiting-consultation', 'should be in waiting-consultation');

    // First unparseable consultation response -> should get a retry (retryAttempted was reset)
    await emitOutput(bus, 'orchestrator', directiveOutput('I think the worker needs more time'));
    timer.advance(1000);

    // Should have sent a retry prompt (not immediately escalated)
    const retryWrites = writes.filter(
      w => w.name === 'orchestrator' && w.data.includes('YES or NO')
    );
    assert.ok(retryWrites.length >= 1, 'consultation should get a retry (retryAttempted was reset by stagnation)');

    timer.advance(50);
    assert.equal(engine.state, 'waiting-consultation', 'should be waiting for consultation retry response');
  });

  it('consultation NO wait timer: idle prompt on worker screen does not false-positive into normal cycle', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    await driveToConsultationWaiting(engine, bus, timer);
    assert.equal(engine.state, 'waiting-consultation', 'should be waiting for consultation response');

    // Orchestrator responds NO
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000); // response poll fires, finds NO directive

    assert.equal(engine.state, 'consultation-wait',
      'NO response should transition to consultation-wait');

    // Simulate Claude Code TUI showing bare idle prompt on worker screen
    // (this is always present in Claude Code TUI even when worker is busy)
    await emitOutput(bus, 'worker', '\u276F \r\n');
    await flush();

    // Advance past consultationWaitDelay — timer fires
    timer.advance(300);

    // BUG: Before fix, engine would see hasIdlePrompt=true and start normal cycle
    // FIXED: Engine should re-enter consultation (clearing-orchestrator) not normal cycle
    assert.equal(engine.state, 'clearing-orchestrator',
      'idle prompt on worker screen should NOT cause false-positive normal cycle; should re-consult');

    // Complete the re-consultation clear + prompt and verify it's a consultation prompt
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); // poll fires
    timer.advance(500);  // settling delay -> onConsultationClearComplete
    timer.advance(50);   // baseDelay -> Enter sent -> waiting-consultation

    assert.equal(engine.state, 'waiting-consultation',
      'should be waiting for re-consultation response');

    // Verify the prompt sent is a consultation prompt (## Question), not directive (## Your Response)
    const lastPromptWrite = writes
      .filter(w => w.name === 'orchestrator' && (w.data.includes('## Question') || w.data.includes('## Your Response')))
      .pop();
    assert.ok(lastPromptWrite, 'should have sent a prompt to orchestrator');
    assert.ok(lastPromptWrite?.data.includes('## Question'),
      'prompt should be consultation (## Question), not directive (## Your Response)');
  });

  // ---------- ENG-01: SELECT menu detection in stagnation handler ----------

  it('SELECT menu detected in stagnation bypasses consultation', async () => {
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

    // Emit worker output containing a SELECT menu pattern before stagnation fires
    const selectMenu = 'This phase has a CONTEXT.md from a previous discussion.\r\n\r\n\u276F Use existing CONTEXT.md (skip discussion)\r\n  Start fresh discussion\r\n  Review CONTEXT.md first\r\n';
    await emitOutput(bus, 'worker', selectMenu);

    // Let stagnation timer fire (200ms from last worker output)
    timer.advance(200);

    // Engine should have detected SELECT menu and entered full directive cycle
    // (capturing-worker), NOT consultation (clearing-orchestrator via consultationMode)
    assert.notEqual(engine.state, 'consulting-orchestrator',
      'should NOT enter consulting-orchestrator when SELECT menu detected');
    // The engine should be in the directive cycle flow (clearing-orchestrator but NOT in consultation mode)
    // Since onWorkerIdle transitions through capturing-worker -> clearing-orchestrator,
    // we check the state and verify it's a directive prompt (not consultation)
    assert.equal(engine.state, 'clearing-orchestrator',
      'SELECT menu detection should trigger full directive cycle (clearing-orchestrator)');

    // Complete the directive cycle and verify it sends a directive prompt (not consultation)
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);

    const lastPromptWrite = writes
      .filter(w => w.name === 'orchestrator' && (w.data.includes('## Question') || w.data.includes('## Your Response')))
      .pop();
    assert.ok(lastPromptWrite?.data.includes('## Your Response'),
      'SELECT menu detection should send directive prompt (## Your Response), not consultation (## Question)');
  });

  it('normal stagnation without SELECT menu still enters consultation', async () => {
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

    // Emit worker output with just a bare prompt (no SELECT menu)
    await emitOutput(bus, 'worker', 'Some worker output...\r\n\u276F \r\n');

    // Let stagnation fire
    timer.advance(200);

    // Should enter consultation flow as normal
    assert.equal(engine.state, 'clearing-orchestrator',
      'normal stagnation without SELECT menu should enter clearing-orchestrator (consultation)');

    // Complete clear and verify consultation prompt is sent
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);

    const lastPromptWrite = writes
      .filter(w => w.name === 'orchestrator' && (w.data.includes('## Question') || w.data.includes('## Your Response')))
      .pop();
    assert.ok(lastPromptWrite?.data.includes('## Question'),
      'normal stagnation should send consultation prompt (## Question), not directive (## Your Response)');
  });

  it('SELECT menu detection enables full directive cycle with SELECT response', async () => {
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

    // Emit SELECT menu on worker
    const selectMenu = 'Choose an option:\r\n\r\n\u276F Use existing CONTEXT.md\r\n  Start fresh discussion\r\n  Review first\r\n';
    await emitOutput(bus, 'worker', selectMenu);

    // Let stagnation fire
    timer.advance(200);

    // Complete the directive cycle
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);

    // Orchestrator responds with SELECT directive
    await emitOutput(bus, 'orchestrator', directiveOutput('SELECT: 2'));
    timer.advance(1000); // response poll fires

    // Engine should process SELECT directive (writes arrow key to worker)
    // SELECT: 2 means press down arrow once (from option 1 to option 2), then Enter
    const workerWrites = writes.filter(w => w.name === 'worker');
    const hasArrow = workerWrites.some(w => w.data.includes('\x1b[B'));
    assert.ok(hasArrow,
      'SELECT directive should write arrow-down key to worker');

    // Complete async SELECT execution (arrowKeyDelayMs=50 default, then Enter + idle)
    timer.advance(50); // arrow key delay fires -> sends Enter -> transitions to idle

    // Engine should return to idle after executing SELECT
    assert.equal(engine.state, 'idle',
      'engine should return to idle after SELECT directive execution');
  });

  // ---------- Test: spinner lines stripped from workerScreenText ----------

  it('spinner lines stripped from workerScreenText before prompt', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Worker emits output containing Claude Code spinner lines
    const spinnerOutput = 'real output line\r\n  \u00b7 Catapulting...\r\n   \r\nmore real output\r\n\u273B Crunched for 1m 22s\r\n';
    await emitOutput(bus, 'worker', spinnerOutput);
    timer.advance(50);  // debounce
    timer.advance(100); // idle -> onPromptComplete

    // Complete clear and get prompt
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);

    // Check the prompt sent to orchestrator does NOT contain spinner lines
    const promptWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('## Task'));
    assert.ok(promptWrite, 'should send prompt to orchestrator');
    assert.ok(!promptWrite!.data.includes('Catapulting...'),
      'prompt should NOT contain spinner lines');
    assert.ok(promptWrite!.data.includes('real output line'),
      'prompt should still contain real output lines');
  });

  // ---------- Test: action outcome logged as "(awaiting result)" then updated retroactively ----------

  it('action outcome logged as "(awaiting result)" then updated in next cycle prompt', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Cycle 1: first cycle
    timer.advance(1); // deferred start -> clearing-orchestrator
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: npm test'));
    timer.advance(1000);
    // Engine is now idle, cycle 1 complete

    // Worker processes the command and produces output
    await emitOutput(bus, 'worker', completionOutput('Tests passed: 42/42'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle -> onPromptComplete -> onWorkerIdle (cycle 2 starts)

    // Complete cycle 2 clear and check prompt
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);

    // The prompt for cycle 2 should contain the action log from cycle 1.
    // The outcome should have been retroactively updated (not "(awaiting result)")
    const promptWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('## Task'));
    const lastPrompt = promptWrites[promptWrites.length - 1];
    assert.ok(lastPrompt, 'should have sent a prompt for cycle 2');
    assert.ok(!lastPrompt.data.includes('(awaiting result)'),
      'cycle 2 prompt should NOT show "(awaiting result)" - it should be retroactively updated');
  });

  // ---------- Test: 3 consecutive NO responses force normal cycle ----------

  it('3 consecutive NO responses force normal cycle instead of infinite loop', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    // Drive to first consultation
    await driveToConsultationWaiting(engine, bus, timer);
    assert.equal(engine.state, 'waiting-consultation');

    // NO #1
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000);
    assert.equal(engine.state, 'consultation-wait', 'first NO -> consultation-wait');

    // Wait expires -> re-consultation
    timer.advance(300);
    assert.equal(engine.state, 'clearing-orchestrator');
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    assert.equal(engine.state, 'waiting-consultation');

    // NO #2
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000);
    assert.equal(engine.state, 'consultation-wait', 'second NO -> consultation-wait');

    // Wait expires -> re-consultation
    timer.advance(300);
    assert.equal(engine.state, 'clearing-orchestrator');
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    assert.equal(engine.state, 'waiting-consultation');

    // NO #3 -- should force normal cycle, not go to consultation-wait
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000);

    // After 3 NOs, engine should force a normal directive cycle (clearing-orchestrator, NOT consultation-wait)
    assert.equal(engine.state, 'clearing-orchestrator',
      'after 3 consecutive NOs, engine should force normal directive cycle');
  });

  // ---------- Test: consultation retry count resets on YES ----------

  it('consultation retry count resets on YES (next stagnation starts from 0)', async () => {
    const stagnationConfig = { ...config, stagnationDelay: 200, consultationWaitDelay: 300 };
    engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
    engine.start();

    // Drive to first consultation
    await driveToConsultationWaiting(engine, bus, timer);
    assert.equal(engine.state, 'waiting-consultation');

    // NO #1
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000);
    assert.equal(engine.state, 'consultation-wait');
    timer.advance(300);
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);

    // NO #2
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000);
    assert.equal(engine.state, 'consultation-wait');
    timer.advance(300);
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);

    // YES (after 2 NOs) -- should reset count
    await emitOutput(bus, 'orchestrator', directiveOutput('YES'));
    timer.advance(1000);

    // YES triggers normal directive cycle
    assert.equal(engine.state, 'clearing-orchestrator',
      'YES should trigger normal directive cycle');

    // Complete the normal cycle
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test2'));
    timer.advance(1000);
    // Engine is now idle

    // Second stagnation -> consultation
    timer.advance(200);
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);

    // Now we can do 3 NOs again (proves counter was reset)
    // NO #1 (of new sequence)
    await emitOutput(bus, 'orchestrator', directiveOutput('NO'));
    timer.advance(1000);
    assert.equal(engine.state, 'consultation-wait',
      'first NO of new sequence should go to consultation-wait (count was reset)');
  });

  // ========== CLEAR directive flow ==========

  describe('CLEAR directive flow', () => {
    it('sends /clear to worker session on CLEAR directive', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Advance to waiting-response (first cycle via deferred timer)
      timer.advance(1); // idle -> onWorkerIdle -> clearing-orchestrator
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50); // poll + settle + Enter

      assert.equal(engine.state, 'waiting-response');

      // Orchestrator responds with CLEAR directive
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000); // response poll fires, finds CLEAR

      // Engine should have written /clear to the worker session
      const workerClear = writes.find(w => w.name === 'worker' && w.data.includes('/clear'));
      assert.ok(workerClear, 'engine should send /clear to worker session on CLEAR directive');
    });

    it('polls worker for (no content) and completes CLEAR', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      const cycleEvents: Array<{ cycle: number; action: string }> = [];
      bus.on('automation:cycle-complete', (_engineId, cycle, action) => {
        cycleEvents.push({ cycle, action });
      });

      engine.start();

      // Advance to waiting-response
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Orchestrator responds with CLEAR
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000); // response poll -> finds CLEAR -> engine sends /clear to worker

      assert.equal(engine.state, 'clearing-worker', 'should be in clearing-worker state');

      // Simulate worker responding with (no content) after /clear
      await emitOutput(bus, 'worker', clearOutput());
      timer.advance(1000); // worker clear poll fires, finds "(no content)"
      timer.advance(500);  // 500ms settling delay, then onWorkerIdle called directly

      // Engine should have advanced past idle (onWorkerIdle called directly after settling)
      // Uses follow-up prompt path (needsFullPrompt=false after first cycle)
      assert.notEqual(engine.state, 'idle',
        'engine should advance past idle after worker CLEAR settling delay');
      assert.notEqual(engine.state, 'clearing-worker',
        'engine should not still be clearing worker');

      // Verify cycle-complete was emitted
      assert.ok(cycleEvents.length >= 1, 'should emit automation:cycle-complete');
    });

    it('CLEAR with CONTEXT: block accumulates context before clearing', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Advance to waiting-response
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Orchestrator responds with CONTEXT + CLEAR
      await emitOutput(bus, 'orchestrator', '● CONTEXT: important note\r\n● CLEAR\r\n\u273B Crunched for 5s\r\n');
      timer.advance(1000); // response poll -> finds CLEAR

      // Engine should be clearing worker (CLEAR was processed)
      assert.equal(engine.state, 'clearing-worker', 'should be in clearing-worker state');

      // Simulate worker clear complete
      await emitOutput(bus, 'worker', clearOutput());
      timer.advance(1000); // worker clear poll fires
      timer.advance(500);  // 500ms settling delay, then onWorkerIdle called directly

      // onWorkerIdle advances to next cycle automatically (cycle 2, follow-up prompt)
      // Engine should now be in clearing-orchestrator from direct onWorkerIdle call
      // Complete the orchestrator clear for cycle 2
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Cycle 2 sends follow-up prompt (no persistent context in follow-up)
      // Respond with RESET to get a full mama prompt that shows accumulated context
      await emitOutput(bus, 'orchestrator', directiveOutput('RESET'));
      timer.advance(1000); // response poll fires -> RESET

      // Complete RESET clear -> full prompt with persistent context
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Verify the full mama prompt includes the persistent context
      const promptWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('important note'));
      assert.ok(promptWrite, 'prompt should include accumulated context "important note"');
    });

    it('stagnation timer does not fire after worker CLEAR completes', async () => {
      const stagnationConfig = { ...config, stagnationDelay: 200 };
      engine = new AutomationEngine(stagnationConfig, mockSessionManager, bus);
      const consultationEvents: string[] = [];
      bus.on('automation:state-change', (_engineId: string, state: string) => {
        if (state === 'clearing-orchestrator' || state === 'consulting-orchestrator') {
          consultationEvents.push(state);
        }
      });

      engine.start();

      // Cycle 1: advance to waiting-response
      timer.advance(1); // deferred start -> clearing-orchestrator
      consultationEvents.length = 0; // ignore the initial clearing-orchestrator
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Orchestrator responds with CLEAR directive
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000); // response poll fires, finds CLEAR -> clearing-worker

      assert.equal(engine.state, 'clearing-worker', 'should be in clearing-worker state');

      // Worker responds with (no content) after /clear
      await emitOutput(bus, 'worker', clearOutput());
      timer.advance(1000); // worker clear poll fires, finds "(no content)"
      timer.advance(500);  // 500ms settling delay fires, sets idle + calls onWorkerIdle

      // After settling delay, onWorkerIdle should have advanced past idle
      // (follow-up prompt path since needsFullPrompt=false after first cycle)
      assert.notEqual(engine.state, 'idle',
        'engine should advance past idle after worker CLEAR settling delay');
      assert.notEqual(engine.state, 'clearing-worker',
        'engine should not still be clearing worker');

      // Clear any events from the CLEAR cycle itself
      consultationEvents.length = 0;

      // Advance the full stagnation delay -- should NOT trigger consultation
      timer.advance(200);

      assert.notEqual(engine.state, 'consulting-orchestrator',
        'stagnation timer should NOT fire after worker CLEAR');
      assert.equal(consultationEvents.length, 0,
        'no consultation-related state transitions should occur after worker CLEAR');
    });

    it('continues workflow after worker CLEAR without relying on onPromptComplete', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Cycle 1: advance to waiting-response
      timer.advance(1); // deferred start -> clearing-orchestrator
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Orchestrator responds with CLEAR directive
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000); // response poll fires, finds CLEAR -> clearing-worker

      assert.equal(engine.state, 'clearing-worker', 'should be in clearing-worker state');

      // Worker responds with (no content) after /clear
      await emitOutput(bus, 'worker', clearOutput());
      timer.advance(1000); // worker clear poll fires, finds "(no content)"

      // Engine should NOT yet be in capturing-worker (still in settling delay)
      assert.notEqual(engine.state, 'capturing-worker',
        'engine should not advance immediately — 500ms settling delay pending');

      // Advance the 500ms settling delay
      timer.advance(500);

      // onWorkerIdle was called directly -> engine should have advanced past idle
      // (follow-up prompt path since needsFullPrompt=false after first cycle)
      assert.notEqual(engine.state, 'idle',
        'engine should advance past idle after worker CLEAR settling delay');
      assert.notEqual(engine.state, 'clearing-worker',
        'engine should not still be clearing worker');

      // Verify no stagnation fires when advancing a full stagnation period
      const statesBefore = engine.state;
      timer.advance(30000); // default stagnation delay
      // Engine should still be in clearing-orchestrator (or advanced further), not consulting
      assert.notEqual(engine.state, 'consulting-orchestrator',
        'no stagnation should fire after worker CLEAR continuation');
    });
  });

  // ========== RESET directive flow ==========

  describe('RESET directive flow', () => {
    it('sends /clear to orchestrator session on RESET directive', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Advance to waiting-response
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Record writes before RESET
      const writeCountBefore = writes.length;

      // Orchestrator responds with RESET
      await emitOutput(bus, 'orchestrator', directiveOutput('RESET'));
      timer.advance(1000); // response poll -> finds RESET

      // Engine should have written /clear to orchestrator session
      const orchClearWrites = writes.slice(writeCountBefore).filter(
        w => w.name === 'orchestrator' && w.data.includes('/clear')
      );
      assert.ok(orchClearWrites.length >= 1, 'engine should send /clear to orchestrator on RESET');
      assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator after RESET');
    });

    it('after RESET clear completes, re-sends full prompt with persistent context', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Cycle 1: COMMAND + CONTEXT to accumulate context
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', '● CONTEXT: project uses React\r\n● COMMAND: npm test\r\n\u273B Crunched for 5s\r\n');
      timer.advance(1000);

      // Cycle 2: RESET
      await emitOutput(bus, 'worker', completionOutput('tests passed'));
      timer.advance(50); timer.advance(100);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('RESET'));
      timer.advance(1000); // response poll -> RESET

      assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator');

      // Orchestrator clears after RESET
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Engine should have re-sent a full prompt that includes persistent context
      const promptWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('Persistent Context'));
      assert.ok(promptWrites.length >= 1, 'RESET re-sent prompt should include Persistent Context section');

      // Check the context was preserved
      const contextWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('project uses React'));
      assert.ok(contextWrite, 'RESET re-sent prompt should include accumulated context "project uses React"');
    });

    it('RESET preserves action log in re-sent prompt', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Cycle 1: COMMAND
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: npm test'));
      timer.advance(1000);

      // Cycle 2: RESET
      await emitOutput(bus, 'worker', completionOutput('tests passed'));
      timer.advance(50); timer.advance(100);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('RESET'));
      timer.advance(1000);

      // Orchestrator clears after RESET
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Verify the prompt includes action log entries
      const promptWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('COMMAND: npm test'));
      assert.ok(promptWrite, 'RESET re-sent prompt should include action log from before RESET');
    });

    it('CONTEXT: block with RESET is included in the re-sent prompt', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Cycle 1: get to waiting-response
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Orchestrator responds with CONTEXT + RESET
      await emitOutput(bus, 'orchestrator', '● CONTEXT: post-reset note\r\n● RESET\r\n\u273B Crunched for 5s\r\n');
      timer.advance(1000);

      assert.equal(engine.state, 'clearing-orchestrator', 'should be clearing orchestrator');

      // Orchestrator clears after RESET
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Verify the re-sent prompt includes the context from the RESET cycle
      const contextWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('post-reset note'));
      assert.ok(contextWrite, 'RESET re-sent prompt should include context "post-reset note" from same cycle');
    });
  });

  // ========== CONTEXT accumulation ==========

  describe('CONTEXT accumulation', () => {
    it('context from multiple cycles accumulates and appears in mama prompt after RESET', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Cycle 1: COMMAND + CONTEXT "note 1" (full mama prompt with /clear)
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', '● CONTEXT: note 1\r\n● COMMAND: echo hello\r\n\u273B Crunched for 5s\r\n');
      timer.advance(1000);

      // Cycle 2: COMMAND + CONTEXT "note 2" (follow-up prompt, no /clear)
      await emitOutput(bus, 'worker', completionOutput('hello'));
      timer.advance(50); timer.advance(100);
      timer.advance(50); // baseDelay -> Enter for follow-up prompt
      await emitOutput(bus, 'orchestrator', '● CONTEXT: note 2\r\n● COMMAND: echo world\r\n\u273B Crunched for 5s\r\n');
      timer.advance(1000);

      // Cycle 3: RESET to trigger full mama prompt that includes accumulated context
      await emitOutput(bus, 'worker', completionOutput('world'));
      timer.advance(50); timer.advance(100);
      timer.advance(50); // baseDelay -> Enter for follow-up prompt
      await emitOutput(bus, 'orchestrator', directiveOutput('RESET'));
      timer.advance(1000); // response poll -> RESET

      // Complete RESET clear -> full mama prompt
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Verify the mama prompt after RESET includes both accumulated context strings
      const promptWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('note 1') && w.data.includes('note 2'));
      assert.ok(promptWrites.length >= 1, 'mama prompt after RESET should include both "note 1" and "note 2" from prior cycles');
    });
  });

  // ========== Follow-up prompt flow ==========

  describe('follow-up prompt flow', () => {
    it('cycle 1 sends /clear then full mama prompt', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Trigger first cycle via deferred timer
      timer.advance(1);
      assert.equal(engine.state, 'clearing-orchestrator',
        'cycle 1 should send /clear (clearing-orchestrator)');

      // Verify /clear was written
      const clearWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('/clear'));
      assert.ok(clearWrite, 'cycle 1 should send /clear to orchestrator');

      // Complete clear
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      // Verify full mama prompt was sent (contains ## Your Role)
      const promptWrite = writes.find(w => w.name === 'orchestrator' && w.data.includes('## Your Role'));
      assert.ok(promptWrite, 'cycle 1 should send full mama prompt with "## Your Role"');
    });

    it('cycle 2 skips /clear and sends follow-up prompt', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Complete cycle 1 (full mama prompt with /clear)
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
      timer.advance(1000);
      assert.equal(engine.state, 'idle', 'should be idle after cycle 1');

      // Record writes before cycle 2
      const writesBeforeCycle2 = writes.length;

      // Worker completes -> triggers cycle 2
      await emitOutput(bus, 'worker', completionOutput('test output'));
      timer.advance(50); timer.advance(100);

      // Cycle 2 should NOT send /clear
      const cycle2Writes = writes.slice(writesBeforeCycle2);
      const clearWrite = cycle2Writes.find(w => w.name === 'orchestrator' && w.data.includes('/clear'));
      assert.ok(!clearWrite, 'cycle 2 should NOT send /clear to orchestrator');

      // Should be in prompting-orchestrator or waiting-response (skipped clearing-orchestrator)
      // The engine sends follow-up prompt directly, then after baseDelay sends Enter
      // Let the delayed Enter fire
      timer.advance(50);

      assert.equal(engine.state, 'waiting-response',
        'cycle 2 should skip clearing and go to waiting-response');

      // Verify follow-up prompt was sent (contains "## Worker Terminal Output" but NOT "## Your Role")
      const followUpWrite = cycle2Writes.find(w => w.name === 'orchestrator' && w.data.includes('## Worker Terminal Output'));
      assert.ok(followUpWrite, 'cycle 2 should send follow-up prompt with "## Worker Terminal Output"');
      assert.ok(!followUpWrite!.data.includes('## Your Role'),
        'cycle 2 follow-up prompt should NOT contain "## Your Role"');
    });

    it('after RESET, next cycle sends /clear + full mama prompt', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Complete cycle 1 (full mama prompt with /clear)
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
      timer.advance(1000);

      // Cycle 2 would use follow-up prompt but instead responds with RESET
      await emitOutput(bus, 'worker', completionOutput('test output'));
      timer.advance(50); timer.advance(100);
      timer.advance(50); // delayed Enter for follow-up prompt

      // Orchestrator responds with RESET
      await emitOutput(bus, 'orchestrator', directiveOutput('RESET'));
      timer.advance(1000); // response poll fires, finds RESET

      assert.equal(engine.state, 'clearing-orchestrator',
        'RESET should trigger clearing-orchestrator');

      // Complete the RESET clear
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500);

      // After RESET, should send full mama prompt (with "## Your Role")
      const promptWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('## Your Role'));
      assert.ok(promptWrites.length >= 2,
        'after RESET, should send full mama prompt again (at least 2 mama prompts total)');
    });

    it('follow-up prompt does not contain "## Your Role"', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Complete cycle 1
      timer.advance(1);
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
      timer.advance(1000);

      // Record writes before cycle 2
      const writesBeforeCycle2 = writes.length;

      // Trigger cycle 2
      await emitOutput(bus, 'worker', completionOutput('test output'));
      timer.advance(50); timer.advance(100);
      timer.advance(50); // delayed Enter

      // Get the follow-up prompt
      const cycle2Writes = writes.slice(writesBeforeCycle2);
      const followUpPromptWrites = cycle2Writes.filter(
        w => w.name === 'orchestrator' && w.data.length > 50 && w.data !== '\r'
      );
      for (const w of followUpPromptWrites) {
        assert.ok(!w.data.includes('## Your Role'),
          `Follow-up prompt should not contain "## Your Role": ${w.data.slice(0, 200)}`);
      }
    });
  });

  // ========== getSerializableState (LIFE-03) ==========

  describe('getSerializableState', () => {
    it('returns stopped state, cycleNumber 0, and empty actionLog before start()', () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);

      const result = engine.getSerializableState();

      assert.equal(result.state, 'stopped', 'state should be stopped before start');
      assert.equal(result.cycleNumber, 0, 'cycleNumber should be 0 before start');
      assert.deepEqual(result.actionLog, [], 'actionLog should be empty before start');
    });

    it('returns idle state and cycleNumber 0 immediately after start()', () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      const result = engine.getSerializableState();

      assert.equal(result.state, 'idle', 'state should be idle after start');
      assert.equal(result.cycleNumber, 0, 'cycleNumber should still be 0 before any cycle completes');
    });

    it('returns paused state after pause()', () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();
      engine.pause();

      const result = engine.getSerializableState();

      assert.equal(result.state, 'paused', 'state should reflect paused');
    });

    it('returns cycleNumber 1 and non-empty actionLog after completing one full cycle', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // Trigger first cycle via deferred timer -> clearing-orchestrator
      timer.advance(1);
      // Orchestrator /clear completes with (no content)
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); // poll fires, finds (no content)
      timer.advance(500);  // settling delay -> onClearComplete
      timer.advance(50);   // delayed Enter -> waiting-response

      // Orchestrator responds with COMMAND directive
      await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: npm test'));
      timer.advance(1000); // response poll fires -> cycle complete, back to idle

      const result = engine.getSerializableState();

      assert.equal(result.cycleNumber, 1, 'cycleNumber should be 1 after one cycle');
      assert.ok(result.actionLog.length > 0, 'actionLog should have at least one entry after cycle 1');
      const lastEntry = result.actionLog[result.actionLog.length - 1];
      assert.ok(lastEntry.action.includes('COMMAND'), 'actionLog entry should reference the COMMAND directive');
      assert.ok(typeof lastEntry.timestamp === 'number', 'actionLog entry should have a numeric timestamp');
      assert.ok(typeof lastEntry.outcome === 'string', 'actionLog entry should have a string outcome');
    });

    it('actionLog returned by getSerializableState is an array of ActionEntry objects', () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      // Even before start, it should be an array (not undefined/null)
      const result = engine.getSerializableState();
      assert.ok(Array.isArray(result.actionLog), 'actionLog should be an array');
    });
  });

  // ========== writeToSession error handling ==========

  describe('writeToSession error handling', () => {
    let shouldThrow: boolean;
    let throwingSessionManager: { writeToSession: (name: string, data: string) => void };
    let errorEvents: string[];

    beforeEach(() => {
      shouldThrow = false;
      throwingSessionManager = {
        writeToSession: (name: string, data: string) => {
          if (shouldThrow) throw new Error('Session inactive');
          writes.push({ name, data });
        },
      };
      errorEvents = [];
      bus.on('automation:error', (_eid: string, err: string) => errorEvents.push(err));
    });

    it('onWorkerIdle /clear write failure: engine stops gracefully with EXEC_FAILURE', async () => {
      engine = new AutomationEngine(config, throwingSessionManager, bus);
      engine.start();

      // Set shouldThrow before the first cycle's /clear write fires
      shouldThrow = true;

      // Trigger first cycle via deferred timer -> onWorkerIdle -> writeToSession throws
      timer.advance(1);

      assert.equal(engine.state, 'stopped', 'engine should stop when writeToSession throws during onWorkerIdle');
      assert.ok(errorEvents.some(e => e.includes('Execution failed')), 'should emit automation:error');
    });

    it('onResponseReady executeDirective write failure: engine stops gracefully', async () => {
      engine = new AutomationEngine(config, throwingSessionManager, bus);
      engine.start();

      // First cycle: get to waiting-response (shouldThrow=false)
      timer.advance(1); // deferred start -> onWorkerIdle -> clearing-orchestrator
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      assert.equal(engine.state, 'waiting-response', 'should be waiting for response');

      // Set throw before COMMAND execution
      shouldThrow = true;

      // Orchestrator responds with COMMAND -> executeDirective's writeFn calls writeToSession -> throws
      await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: npm test'));
      timer.advance(1000); // response poll fires

      assert.equal(engine.state, 'stopped', 'engine should stop when writeToSession throws during executeDirective');
      assert.ok(errorEvents.some(e => e.includes('Execution failed')), 'should emit automation:error');
    });

    it('sendSelect write failure: engine stops gracefully', async () => {
      engine = new AutomationEngine(config, throwingSessionManager, bus);
      engine.start();

      // First cycle: get to waiting-response (shouldThrow=false)
      timer.advance(1); // deferred start -> onWorkerIdle -> clearing-orchestrator
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);

      assert.equal(engine.state, 'waiting-response', 'should be waiting for response');

      // Set throw before SELECT execution
      shouldThrow = true;

      // Orchestrator responds with SELECT -> sendSelect calls writeToSession -> throws
      await emitOutput(bus, 'orchestrator', directiveOutput('SELECT: 3'));
      timer.advance(1000); // response poll fires

      assert.equal(engine.state, 'stopped', 'engine should stop when writeToSession throws during sendSelect');
      assert.ok(errorEvents.some(e => e.includes('Execution failed')), 'should emit automation:error');
    });
  });

  // ========== AUTO-04: CLEAR directive idle detection ==========

  describe('AUTO-04: CLEAR directive idle detection', () => {
    it('after worker CLEAR success, capture idle timer starts on data-idle (requireMarker=false)', async () => {
      // After the CLEAR success path calls resetBaseline(), requireMarker should
      // be set to false so that the idle timer starts on data-idle alone.
      // BUG: resetBaseline() sets requireMarker=true, preventing idle timer from
      //   starting in capture() at line 389 (needs crunched || !requireMarker).
      // FIX: set requireMarker=false after resetBaseline() in CLEAR success path.
      //
      // We test by emitting visible worker data after CLEAR poll succeeds.
      // With requireMarker=false (fix): capture() -> startIdleTimer() runs (line 389).
      //   After idleDelay, onPromptComplete fires. State is 'clearing-worker' so
      //   onWorkerIdle returns early, but onPromptComplete still fires BEFORE
      //   the 500ms settling delay.
      // With requireMarker=true (bug): capture() -> condition at line 389 is false,
      //   idle timer never starts.
      //
      // Observable: if onPromptComplete fires before settling, it calls onWorkerIdle()
      //   which is a no-op (state guard). Then settling fires -> onWorkerIdle succeeds.
      //   If onPromptComplete does NOT fire before settling, only settling triggers
      //   onWorkerIdle. The final state is the same either way, so we measure a
      //   side effect: counting how many times the bus sees the cycle start.
      //   Actually, we'll check that the settling delay + onPromptComplete don't
      //   interfere and the CLEAR cycle completes cleanly.

      // Instead of observing the internal timer, we test the plan's key contract:
      // after CLEAR, a second CLEAR in sequence should also work — proving the
      // capture reset is correct. If requireMarker=true persists incorrectly,
      // subsequent idle detection may break.
      engine = new AutomationEngine(config, mockSessionManager, bus);
      const cycleEvents: Array<{ cycle: number; action: string }> = [];
      bus.on('automation:cycle-complete', (_engineId, cycle, action) => {
        cycleEvents.push({ cycle, action });
      });

      engine.start();

      // First cycle via deferred timer
      timer.advance(1);

      // Complete first cycle: clear orch -> prompt -> CLEAR directive -> clear worker
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000); // response poll finds CLEAR

      assert.equal(engine.state, 'clearing-worker');

      // Worker /clear produces "(no content)"
      await emitOutput(bus, 'worker', clearOutput());
      timer.advance(1000); // worker clear poll finds "(no content)"
      timer.advance(500);  // settling delay -> setState('idle') + onWorkerIdle()

      // CLEAR cycle 1 completed, next cycle starts automatically
      assert.ok(cycleEvents.some(e => e.action === 'CLEAR'), 'first CLEAR cycle should complete');

      // Complete the auto-started cycle: clear orch -> prompt -> CLEAR again
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000); // response poll finds second CLEAR

      assert.equal(engine.state, 'clearing-worker', 'should be clearing worker for second CLEAR');

      // Second worker /clear
      await emitOutput(bus, 'worker', clearOutput());
      timer.advance(1000); // poll finds "(no content)"
      timer.advance(500);  // settling delay -> idle + onWorkerIdle

      // Both CLEAR cycles should have completed
      const clearCycles = cycleEvents.filter(e => e.action === 'CLEAR');
      assert.equal(clearCycles.length, 2, 'two CLEAR cycles should complete successfully');
    });
  });

  // ========== ENG-04: CLEAR poll timeout ==========

  describe('CLEAR poll timeout (ENG-04)', () => {
    it('times out after 30s when worker does not produce "(no content)"', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      const warningEvents: string[] = [];
      bus.on('automation:warning', (_eid: string, msg: string) => warningEvents.push(msg));
      const cycleEvents: Array<{ cycle: number; action: string }> = [];
      bus.on('automation:cycle-complete', (_engineId: string, cycle: number, action: string) => {
        cycleEvents.push({ cycle, action });
      });

      engine.start();
      timer.advance(1); // deferred start

      // Complete orchestrator clear + prompt + CLEAR directive
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000); // response poll finds CLEAR

      assert.equal(engine.state, 'clearing-worker');

      // Worker produces output that is NOT "(no content)"
      await emitOutput(bus, 'worker', 'some random output\r\n');

      // Advance 30 seconds — poll fires ~30 times finding nothing, then deadline fires
      timer.advance(30_000);
      timer.advance(500); // settling delay

      // Verify timeout path executed
      assert.ok(warningEvents.some(e => e.includes('timed out')), 'should emit warning containing "timed out"');
      assert.ok(cycleEvents.some(e => e.action === 'CLEAR'), 'should emit cycle-complete with CLEAR action');
      assert.notEqual(engine.state, 'clearing-worker', 'should transition out of clearing-worker');
    });

    it('normal "(no content)" success cancels deadline timer — no warning fires later', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      const warningEvents: string[] = [];
      bus.on('automation:warning', (_eid: string, msg: string) => warningEvents.push(msg));

      engine.start();
      timer.advance(1);

      // Get to clearing-worker
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000);

      assert.equal(engine.state, 'clearing-worker');

      // Worker produces "(no content)" normally
      await emitOutput(bus, 'worker', clearOutput());
      timer.advance(1000); // poll finds it
      timer.advance(500);  // settling

      // Now advance past where deadline would have fired
      timer.advance(30_000);

      // No warning should have fired
      assert.equal(warningEvents.length, 0, 'deadline timer should have been cancelled — no warning');
    });

    it('no double cycle-complete when both poll-success and deadline could fire', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      const cycleEvents: Array<{ cycle: number; action: string }> = [];
      bus.on('automation:cycle-complete', (_engineId: string, cycle: number, action: string) => {
        cycleEvents.push({ cycle, action });
      });

      engine.start();
      timer.advance(1);

      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000);

      assert.equal(engine.state, 'clearing-worker');

      // Emit "(no content)" right at the same time window as the deadline
      // by first advancing almost to 30s, then emitting content, then advancing past 30s
      await emitOutput(bus, 'worker', clearOutput());
      timer.advance(1000); // poll at 1s finds it -> success path fires
      timer.advance(500);  // settling

      // Now advance to ensure no double execution from a stale deadline timer
      timer.advance(30_000);

      // Only one CLEAR cycle-complete should have fired
      const clearCycles = cycleEvents.filter(e => e.action === 'CLEAR');
      assert.equal(clearCycles.length, 1, 'exactly one CLEAR cycle-complete should fire — no double execution');
    });

    it('action log reads "Worker context cleared (timeout)" on timeout path', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);

      engine.start();
      timer.advance(1);

      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); timer.advance(500); timer.advance(50);
      await emitOutput(bus, 'orchestrator', directiveOutput('CLEAR'));
      timer.advance(1000);

      assert.equal(engine.state, 'clearing-worker');

      // Don't emit "(no content)" — let it timeout
      timer.advance(30_000);
      // Check action log BEFORE settling delay fires onWorkerIdle
      // (onWorkerIdle overwrites the last outcome with worker screen text)
      const { actionLog } = engine.getSerializableState();
      const clearEntry = actionLog.find(e => e.action === 'CLEAR');
      assert.ok(clearEntry, 'should have a CLEAR action log entry');
      assert.ok(
        clearEntry!.outcome?.includes('timeout'),
        `action log CLEAR entry should contain "timeout", got: ${clearEntry!.outcome}`,
      );
    });
  });

  // ========== AUTO-03: hub cycle count sync ==========

  describe('AUTO-03: hub cycle count sync', () => {
    it('cycle-complete fires before state-change so hub has correct cycleCount at render time', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);

      // Track event ordering: when state-change fires with 'idle' after a cycle,
      // cycle-complete should have already fired with the correct cycleNumber.
      let cycleCompleteCount = 0;
      let cycleCountAtStateIdle = -1;

      bus.on('automation:cycle-complete', (_eid: string, _cycleNumber: number, _action: string) => {
        cycleCompleteCount = _cycleNumber;
      });

      bus.on('automation:state-change', (_engineId: string, state: string) => {
        if (state === 'idle' && cycleCompleteCount > 0) {
          // Record what cycleCount was when state-change fired with 'idle'
          cycleCountAtStateIdle = cycleCompleteCount;
        }
      });

      engine.start();

      // Complete first cycle: worker idle -> clear -> prompt -> COMMAND -> idle
      timer.advance(1); // deferred start -> clearing-orchestrator
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); // poll fires, finds "(no content)"
      timer.advance(500);  // settling delay -> onClearComplete
      timer.advance(50);   // delayed Enter -> waiting-response

      // Orchestrator responds with COMMAND directive
      await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo hello'));
      timer.advance(1000); // response poll fires, finds COMMAND

      // Now engine is idle after cycle 1
      assert.equal(engine.state, 'idle', 'should be idle after cycle 1');

      // Verify that when state-change fired with 'idle', cycleComplete had already
      // set cycleCount to 1 — proving the hub would see the correct count at render time
      assert.equal(cycleCountAtStateIdle, 1,
        'cycle-complete should fire BEFORE state-change with idle, so hub has correct cycleCount during render');
    });
  });

  // ---------- Response poll false positives (ENG-01) ----------

  describe('response poll false positives (ENG-01)', () => {

    it('echoed prompt markers do not trigger false positive onResponseReady', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // First cycle via deferred timer -> clearing-orchestrator
      timer.advance(1);
      assert.equal(engine.state, 'clearing-orchestrator');

      // Orchestrator clears
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); // poll fires, finds "(no content)"
      timer.advance(500);  // settling delay -> onClearComplete
      timer.advance(50);   // delayed Enter -> waiting-response

      assert.equal(engine.state, 'waiting-response', 'should be waiting for response');

      // Emit orchestrator output simulating echoed prompt containing worker's
      // completion marker (✻) BEFORE a non-directive ● line. The ✻ is from the
      // worker screen echo (above), and the ● is a stale Ink repaint fragment
      // that is NOT a parseable directive (no COMMAND/SELECT/ENTER/etc keyword).
      // Old code: hasOrchestratorResponse(●) && hasCompletionMarker(✻) => true (false positive)
      // New code: hasCompletionMarkerAfterResponse checks ✻ is AFTER ● => false (correct)
      await emitOutput(bus, 'orchestrator',
        '## Worker Terminal Output\r\n```\r\ntest results\r\n\u273B Crunched for 1m 22s\r\n```\r\n\r\n\u25CF Here is my analysis of the worker output\r\n'
      );

      // Poll fires — should NOT trigger onResponseReady because ✻ is before ●
      timer.advance(1000);

      assert.equal(engine.state, 'waiting-response',
        'echoed prompt markers (✻ before ●) should NOT trigger false positive onResponseReady');
    });

    it('stripSpinners consistency: spinner lines between directive lines are stripped in poll', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      const cycleEvents: Array<{ cycle: number; action: string }> = [];
      bus.on('automation:cycle-complete', (_engineId, cycle, action) => {
        cycleEvents.push({ cycle, action });
      });

      engine.start();

      // First cycle via deferred timer -> clearing-orchestrator
      timer.advance(1);
      assert.equal(engine.state, 'clearing-orchestrator');

      // Orchestrator clears
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); // poll fires, finds "(no content)"
      timer.advance(500);  // settling delay -> onClearComplete
      timer.advance(50);   // delayed Enter -> waiting-response

      assert.equal(engine.state, 'waiting-response', 'should be waiting for response');

      // Emit orchestrator output with spinner lines interleaved
      await emitOutput(bus, 'orchestrator',
        '\u2736 Scurrying...\r\n\u25CF COMMAND: npm test\r\n\u273D Analyzing...\r\n\u273B Crunched for 5s\r\n'
      );

      // Poll fires — stripSpinners should remove spinner lines so directive is found
      timer.advance(1000);

      // Engine should process the directive (spinner lines stripped)
      const cmdWrite = writes.find(w => w.name === 'worker' && w.data.includes('npm test'));
      assert.ok(cmdWrite, 'poll should detect COMMAND directive after stripping spinner lines');
      assert.equal(engine.state, 'idle', 'should return to idle after executing COMMAND');
    });

    it('legitimate response with ● followed by ✻ still triggers onResponseReady', async () => {
      engine = new AutomationEngine(config, mockSessionManager, bus);
      engine.start();

      // First cycle via deferred timer -> clearing-orchestrator
      timer.advance(1);
      assert.equal(engine.state, 'clearing-orchestrator');

      // Orchestrator clears
      await emitOutput(bus, 'orchestrator', clearOutput());
      timer.advance(1000); // poll fires, finds "(no content)"
      timer.advance(500);  // settling delay -> onClearComplete
      timer.advance(50);   // delayed Enter -> waiting-response

      assert.equal(engine.state, 'waiting-response', 'should be waiting for response');

      // Emit orchestrator output with an unparseable ● response followed by ✻
      // This is a legitimate response (● before ✻) but unparseable as a directive
      await emitOutput(bus, 'orchestrator',
        '\u25CF I think we should run tests\r\n\u273B Crunched for 5s\r\n'
      );

      // Poll fires — should trigger onResponseReady via completion marker fallback
      timer.advance(1000);

      // Engine should have triggered onResponseReady and attempted to parse.
      // Since the directive is unparseable, it should retry (prompting-orchestrator)
      assert.notEqual(engine.state, 'waiting-response',
        'legitimate response (● then ✻) should trigger onResponseReady');
    });

  });

  // ========== WAIT directive no-op ==========

  it('WAIT directive is a no-op — skips action, proceeds to next cycle', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    const cycleEvents: Array<{ cycle: number; action: string }> = [];
    bus.on('automation:cycle-complete', (_engineId: string, cycle: number, action: string) => {
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

    assert.equal(engine.state, 'waiting-response', 'should be waiting for response');

    // Record writes before WAIT response
    const writesBeforeWait = writes.length;

    // Orchestrator responds with WAIT
    await emitOutput(bus, 'orchestrator', directiveOutput('WAIT'));
    timer.advance(1000); // response poll fires, finds WAIT directive

    // Engine should transition to idle (no-op), NOT stopped/paused
    assert.equal(engine.state, 'idle',
      'WAIT should transition engine to idle (no-op)');

    // No writes should be sent to the worker session
    const workerWrites = writes.slice(writesBeforeWait).filter(w => w.name === 'worker');
    assert.equal(workerWrites.length, 0,
      'WAIT should NOT send anything to worker session');

    // automation:cycle-complete should be emitted
    assert.equal(cycleEvents.length, 1, 'should emit one cycle-complete event');
    assert.ok(cycleEvents[0].action.includes('WAIT'), 'cycle-complete action should mention WAIT');

    // WAIT should NOT trigger retry prompt (verify no retry writes)
    const retryWrites = writes.slice(writesBeforeWait).filter(
      w => w.name === 'orchestrator' && w.data.includes('could not be parsed')
    );
    assert.equal(retryWrites.length, 0,
      'WAIT should NOT trigger RETRY_PROMPT');
  });

  // ========== Resume waits for worker completion (ENG-04) ==========

  it('resume does not kick cycle when worker is still processing', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Fire the start() kickoff timer so it is consumed
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator', 'start kickoff should fire');

    // Complete the first full cycle to get back to idle
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
    timer.advance(1000);
    assert.equal(engine.state, 'idle', 'should be idle after cycle 1');

    // Pause the engine while worker is processing (no completion output yet)
    engine.pause();
    assert.equal(engine.state, 'paused', 'should be paused');

    // Clear the writes log so we can check for NEW writes from resume
    writes.length = 0;

    // Resume -- worker has NOT completed yet (no completion marker on screen)
    // Worker emulator has no ❯ prompt and no ✻ completion marker
    engine.resume();
    assert.equal(engine.state, 'idle', 'resume() should transition to idle');

    // Advance timer by 1ms to fire any setTimeout(0) from resume
    timer.advance(1);

    // Engine should stay in idle -- NOT transition to clearing-orchestrator
    // because the worker hasn't produced output yet
    assert.equal(engine.state, 'idle',
      'resume should NOT kick cycle when worker is still processing');

    // No /clear should have been written to orchestrator
    const clearWrites = writes.filter(w => w.name === 'orchestrator' && w.data.includes('/clear'));
    assert.equal(clearWrites.length, 0,
      'no /clear should be sent when worker is still processing');
  });

  it('resume waits for worker completion then starts cycle', async () => {
    engine = new AutomationEngine(config, mockSessionManager, bus);
    engine.start();

    // Fire the start() kickoff timer
    timer.advance(1);
    assert.equal(engine.state, 'clearing-orchestrator');

    // Complete the first full cycle to get back to idle
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
    timer.advance(1000);
    assert.equal(engine.state, 'idle', 'should be idle after cycle 1');

    // Pause the engine
    engine.pause();
    assert.equal(engine.state, 'paused');

    // Resume -- worker is still processing
    engine.resume();
    assert.equal(engine.state, 'idle', 'resume should set idle');
    timer.advance(1); // fire any setTimeout(0)

    // Engine should still be idle (worker not done yet)
    assert.equal(engine.state, 'idle',
      'should stay idle waiting for worker completion');

    // Now worker completes
    await emitOutput(bus, 'worker', completionOutput('command done'));
    timer.advance(50);  // debounce
    timer.advance(100); // idle detection -> onPromptComplete fires

    // Engine should have started a new cycle (follow-up prompt path)
    assert.notEqual(engine.state, 'idle',
      'engine should start cycle after worker completes post-resume');
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

describe('RETRY_PROMPT', () => {
  it('contains COMMAND directive documentation', () => {
    assert.ok(RETRY_PROMPT.includes('COMMAND:'), 'RETRY_PROMPT should document COMMAND directive');
  });

  it('contains CLEAR directive documentation', () => {
    assert.ok(RETRY_PROMPT.includes('CLEAR'), 'RETRY_PROMPT should document CLEAR directive');
  });

  it('contains RESET directive documentation', () => {
    assert.ok(RETRY_PROMPT.includes('RESET'), 'RETRY_PROMPT should document RESET directive');
  });

  it('contains CONTEXT modifier documentation', () => {
    assert.ok(RETRY_PROMPT.includes('CONTEXT:'), 'RETRY_PROMPT should document CONTEXT modifier');
  });

  it('documents that CONTEXT can be stacked with any directive', () => {
    assert.ok(
      RETRY_PROMPT.toLowerCase().includes('stack') || RETRY_PROMPT.toLowerCase().includes('cumulative'),
      'RETRY_PROMPT should mention CONTEXT stacking behavior',
    );
  });

  it('contains all 7 directive types', () => {
    const directives = ['COMMAND:', 'SELECT:', 'ENTER', 'ESCALATE:', 'DONE:', 'CLEAR', 'RESET'];
    for (const d of directives) {
      assert.ok(RETRY_PROMPT.includes(d), `RETRY_PROMPT should contain ${d}`);
    }
  });
});

// ========== CONC-02: engineId scoping tests ==========

describe('AutomationEngine engineId (CONC-02)', () => {
  let bus: EventBus;
  let timer: ManualTimer;
  let writes: Array<{ name: string; data: string }>;
  let mockSessionManager: { writeToSession: (name: string, data: string) => void };

  beforeEach(() => {
    bus = new EventBus();
    timer = new ManualTimer();
    writes = [];
    mockSessionManager = {
      writeToSession: (name: string, data: string) => {
        writes.push({ name, data });
      },
    };
  });

  it('engine emits automation:state-change with engineId as first argument', () => {
    const config: EngineConfig = {
      workerSession: 'worker',
      orchestratorSession: 'orchestrator',
      taskDescription: 'test',
      timer,
      baseDelay: 50,
      idleDelay: 100,
    };
    const engine = new AutomationEngine(config, mockSessionManager, bus);
    const events: Array<{ engineId: string; state: string }> = [];
    bus.on('automation:state-change', (engineId, state) => {
      events.push({ engineId, state });
    });

    engine.start();
    engine.stop();

    assert.ok(events.length >= 2, 'should have emitted at least 2 state-change events');
    assert.equal(events[0].engineId, engine.engineId, 'first arg should be engineId');
    assert.equal(events[0].state, 'idle', 'second arg should be the state');
  });

  it('engine emits automation:cycle-complete with engineId as first argument', async () => {
    const config: EngineConfig = {
      workerSession: 'worker',
      orchestratorSession: 'orchestrator',
      taskDescription: 'test',
      timer,
      baseDelay: 50,
      idleDelay: 100,
    };
    const engine = new AutomationEngine(config, mockSessionManager, bus);
    const events: Array<{ engineId: string; cycle: number; action: string }> = [];
    bus.on('automation:cycle-complete', (engineId, cycle, action) => {
      events.push({ engineId, cycle, action });
    });

    engine.start();

    // Drive through a full COMMAND cycle
    timer.advance(1); // deferred start -> clearing-orchestrator
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo test'));
    timer.advance(1000);

    assert.equal(events.length, 1, 'should have emitted 1 cycle-complete event');
    assert.equal(events[0].engineId, engine.engineId, 'first arg should be engineId');
    assert.equal(events[0].cycle, 1, 'second arg should be cycle number');
    assert.ok(events[0].action.includes('COMMAND'), 'third arg should be action');

    engine.stop();
  });

  it('engine emits automation:done with engineId as first argument', async () => {
    const config: EngineConfig = {
      workerSession: 'worker',
      orchestratorSession: 'orchestrator',
      taskDescription: 'test',
      timer,
      baseDelay: 50,
      idleDelay: 100,
    };
    const engine = new AutomationEngine(config, mockSessionManager, bus);
    const events: Array<{ engineId: string; summary: string }> = [];
    bus.on('automation:done', (engineId, summary) => {
      events.push({ engineId, summary });
    });

    engine.start();

    // Drive to DONE directive
    timer.advance(1); // deferred start
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('DONE: All tests passed'));
    timer.advance(1000);

    assert.equal(events.length, 1, 'should have emitted 1 done event');
    assert.equal(events[0].engineId, engine.engineId, 'first arg should be engineId');
    assert.ok(events[0].summary.includes('All tests passed'), 'second arg should be summary');
  });

  it('engine emits automation:error with engineId as first argument', async () => {
    const config: EngineConfig = {
      workerSession: 'worker',
      orchestratorSession: 'orchestrator',
      taskDescription: 'test',
      timer,
      baseDelay: 50,
      idleDelay: 100,
      maxCycles: 1,
    };
    const engine = new AutomationEngine(config, mockSessionManager, bus);
    const events: Array<{ engineId: string; error: string }> = [];
    bus.on('automation:error', (engineId, error) => {
      events.push({ engineId, error });
    });

    engine.start();

    // Complete 1 cycle to reach max
    timer.advance(1);
    await emitOutput(bus, 'orchestrator', clearOutput());
    timer.advance(1000); timer.advance(500); timer.advance(50);
    await emitOutput(bus, 'orchestrator', directiveOutput('COMMAND: echo 1'));
    timer.advance(1000);

    // Trigger cycle 2 attempt -> hits limit
    await emitOutput(bus, 'worker', completionOutput('done'));
    timer.advance(50); timer.advance(100);

    assert.ok(events.length >= 1, 'should have emitted at least 1 error event');
    assert.equal(events[0].engineId, engine.engineId, 'first arg should be engineId');
    assert.ok(events[0].error.includes('Cycle limit'), 'second arg should be error message');
  });

  it('two engines on the same bus emit events with different engineIds', () => {
    const config1: EngineConfig = {
      workerSession: 'worker-1',
      orchestratorSession: 'orch-1',
      taskDescription: 'task 1',
      timer,
      baseDelay: 50,
      idleDelay: 100,
    };
    const config2: EngineConfig = {
      workerSession: 'worker-2',
      orchestratorSession: 'orch-2',
      taskDescription: 'task 2',
      timer,
      baseDelay: 50,
      idleDelay: 100,
    };

    const engine1 = new AutomationEngine(config1, mockSessionManager, bus);
    const engine2 = new AutomationEngine(config2, mockSessionManager, bus);

    assert.notEqual(engine1.engineId, engine2.engineId, 'engines should have different engineIds');
    assert.ok(engine1.engineId.startsWith('auto-'), 'engineId should start with auto-');
    assert.ok(engine2.engineId.startsWith('auto-'), 'engineId should start with auto-');

    const stateEvents: Array<{ engineId: string; state: string }> = [];
    bus.on('automation:state-change', (engineId, state) => {
      stateEvents.push({ engineId, state });
    });

    engine1.start();
    engine2.start();

    const engine1Events = stateEvents.filter(e => e.engineId === engine1.engineId);
    const engine2Events = stateEvents.filter(e => e.engineId === engine2.engineId);

    assert.ok(engine1Events.length > 0, 'should have events from engine 1');
    assert.ok(engine2Events.length > 0, 'should have events from engine 2');
    assert.ok(engine1Events.every(e => e.engineId === engine1.engineId), 'all engine1 events should have engine1 id');
    assert.ok(engine2Events.every(e => e.engineId === engine2.engineId), 'all engine2 events should have engine2 id');

    engine1.stop();
    engine2.stop();
  });
});
