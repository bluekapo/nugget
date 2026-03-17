/**
 * Regression safety tests for phase 35/36 per-session emulator refactor.
 *
 * REGR-01: Automation engine isolation — resetBaseline() still works correctly
 *          and coexists with swapEmulator() on the same ScreenCapture instance.
 * REGR-02: Existing ScreenCapture test suite health — core pipeline end-to-end.
 * REGR-03: becomeNewPrimary parity — structural assertions that becomeNewPrimary
 *          has the same per-session emulator patterns as startPrimary.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TerminalEmulator } from '../../src/terminal/emulator.js';
import { ScreenCapture } from '../../src/terminal/capture.js';
import type { TimerProvider, OutputEvent } from '../../src/terminal/capture.js';

// ---------------------------------------------------------------------------
// ManualTimer — deterministic timer for testing ScreenCapture behavior.
// Same pattern as capture.test.ts and completion-tracker.test.ts.
// ---------------------------------------------------------------------------

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
      this._now = target;
      // Fire all timers that are due
      for (const [id, timer] of this._timers) {
        if (timer.fireAt <= this._now) {
          this._timers.delete(id);
          timer.callback();
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// REGR-01: Automation engine isolation from swapEmulator
// ---------------------------------------------------------------------------

describe('REGR-01: automation engine isolation from swapEmulator', () => {
  let emulator: TerminalEmulator;
  let timer: ManualTimer;
  let events: OutputEvent[];
  let capture: ScreenCapture;

  beforeEach(() => {
    emulator = new TerminalEmulator(80, 24);
    timer = new ManualTimer();
    events = [];
    capture = new ScreenCapture(emulator, (ev) => events.push(ev), { timer });
  });

  it('resetBaseline() resets state so next capture triggers initial', async () => {
    // Write data and let it capture
    await capture.onData('Hello world\r\n');
    timer.advance(200);
    assert.ok(events.length > 0, 'Should have at least one event after initial data');
    const firstTrigger = events[0].trigger;
    assert.equal(firstTrigger, 'initial', 'First capture should be initial trigger');

    // Reset baseline — this should clear capture state
    capture.resetBaseline();
    events.length = 0;

    // Write new data — next capture should be 'initial' again since captureCount was reset
    await capture.onData('After reset\r\n');
    timer.advance(200);
    assert.ok(events.length > 0, 'Should have events after resetBaseline + new data');
    assert.equal(events[0].trigger, 'initial', 'After resetBaseline, next capture should trigger initial');
  });

  it('resetBaseline() and swapEmulator() coexist on same instance', async () => {
    // First: use resetBaseline
    await capture.onData('Before reset\r\n');
    timer.advance(200);
    capture.resetBaseline();
    events.length = 0;

    // Then: use swapEmulator
    const newEmulator = new TerminalEmulator(80, 24);
    capture.swapEmulator(newEmulator);

    // Write data through the swapped emulator
    await capture.onData('After swap\r\n');
    timer.advance(200);
    assert.ok(events.length > 0, 'Should have events after swapEmulator + new data');
    assert.equal(events[0].trigger, 'initial', 'After swapEmulator, next capture should trigger initial');

    // Now use resetBaseline again on the same instance
    capture.resetBaseline();
    events.length = 0;

    await capture.onData('After second reset\r\n');
    timer.advance(200);
    assert.ok(events.length > 0, 'Should have events after second resetBaseline');
    assert.equal(events[0].trigger, 'initial', 'After second resetBaseline, next capture should trigger initial');

    // Cleanup
    newEmulator.dispose();
  });

  it('resetBaseline() calls emulator.reset() clearing screen content', async () => {
    // Write data to emulator through capture
    await capture.onData('Some visible content\r\n');
    timer.advance(200);

    // Verify emulator has content
    const beforeReset = emulator.getScreenText();
    assert.ok(beforeReset.includes('Some visible content'), 'Emulator should have content before reset');

    // resetBaseline() should call emulator.reset()
    capture.resetBaseline();

    // Verify emulator screen is now empty
    const afterReset = emulator.getScreenText();
    assert.equal(afterReset, '', 'Emulator screen should be empty after resetBaseline()');
  });
});

// ---------------------------------------------------------------------------
// REGR-02: Existing ScreenCapture test suite health
// ---------------------------------------------------------------------------

describe('REGR-02: existing ScreenCapture test suite health', () => {
  let timer: ManualTimer;
  let events: OutputEvent[];

  beforeEach(() => {
    timer = new ManualTimer();
    events = [];
  });

  it('core pipeline: create, write data, capture output end-to-end', async () => {
    const emulator = new TerminalEmulator(80, 24);
    const capture = new ScreenCapture(emulator, (ev) => events.push(ev), { timer });

    // Feed data through the pipeline
    await capture.onData('Hello from pipeline\r\n');
    timer.advance(200);

    assert.ok(events.length > 0, 'Should produce output events');
    assert.ok(events[0].text.includes('Hello from pipeline'), 'Output should contain written text');
    assert.equal(events[0].mode, 'replace', 'First event should be replace mode');
    assert.equal(events[0].trigger, 'initial', 'First event should be initial trigger');

    // Cleanup
    capture.dispose();
    emulator.dispose();
  });

  it('swapEmulator followed by onData produces output from new emulator', async () => {
    const emulator1 = new TerminalEmulator(80, 24);
    const capture = new ScreenCapture(emulator1, (ev) => events.push(ev), { timer });

    // Write to original emulator
    await capture.onData('Original emulator data\r\n');
    timer.advance(200);

    // Swap to new emulator
    const emulator2 = new TerminalEmulator(80, 24);
    capture.swapEmulator(emulator2);
    events.length = 0;

    // Write through capture — data should go to new emulator
    await capture.onData('New emulator data\r\n');
    timer.advance(200);

    assert.ok(events.length > 0, 'Should produce output after swap');
    assert.ok(events[0].text.includes('New emulator data'), 'Output should contain new emulator text');
    // swapEmulator resets captureCount, so first capture after swap is 'initial'
    assert.equal(events[0].trigger, 'initial', 'First capture after swap should be initial');

    // Verify original emulator text is NOT in the output (clean swap)
    assert.ok(!events[0].text.includes('Original emulator data'),
      'New emulator output should not contain old emulator data');

    // Cleanup
    capture.dispose();
    emulator1.dispose();
    emulator2.dispose();
  });
});

// ---------------------------------------------------------------------------
// REGR-03: becomeNewPrimary parity with startPrimary
// ---------------------------------------------------------------------------

describe('REGR-03: becomeNewPrimary parity', () => {
  // Read source file once for the describe block
  const indexPath = resolve(import.meta.dirname, '../../src/index.ts');
  const source = readFileSync(indexPath, 'utf-8');

  // Extract becomeNewPrimary function body:
  // Find "async function becomeNewPrimary" and take everything until the next
  // top-level "async function" or "function " at the start of a line (non-indented).
  const startMatch = source.match(/async function becomeNewPrimary\b/);
  assert.ok(startMatch && startMatch.index !== undefined, 'becomeNewPrimary must exist in source');
  const bodyStart = startMatch.index!;

  // Find the next top-level function after becomeNewPrimary
  const afterStart = source.slice(bodyStart + 1);
  const nextFnMatch = afterStart.match(/\nasync function \w+|^\nfunction \w+/m);
  const bodyEnd = nextFnMatch && nextFnMatch.index !== undefined
    ? bodyStart + 1 + nextFnMatch.index
    : source.length;
  const body = source.slice(bodyStart, bodyEnd);

  it('contains per-session emulator Map', () => {
    assert.ok(
      body.includes('emulators = new Map<string, TerminalEmulator>()'),
      'becomeNewPrimary should create a per-session emulator Map',
    );
  });

  it('contains getOrCreateEmulator function', () => {
    assert.ok(
      body.includes('function getOrCreateEmulator'),
      'becomeNewPrimary should define getOrCreateEmulator',
    );
  });

  it('contains swapEmulator(targetEmulator) in onSessionSwitch', () => {
    // Verify the onSessionSwitch wiring uses swapEmulator
    assert.ok(
      body.includes('capture.swapEmulator(targetEmulator)'),
      'becomeNewPrimary onSessionSwitch should call capture.swapEmulator(targetEmulator)',
    );
  });

  it('contains emulator dispose and delete in session:exit handler', () => {
    assert.ok(
      body.includes('emu.dispose()'),
      'becomeNewPrimary session:exit should dispose emulator',
    );
    assert.ok(
      body.includes('emulators.delete(name)'),
      'becomeNewPrimary session:exit should delete emulator from Map',
    );
  });

  it('contains getOrCreateEmulator in IPC onRegister handler', () => {
    assert.ok(
      body.includes('getOrCreateEmulator(name)'),
      'becomeNewPrimary IPC onRegister should pre-create emulator via getOrCreateEmulator(name)',
    );
  });

  it('registers SIGWINCH handler', () => {
    assert.ok(
      body.includes("process.on('SIGWINCH'"),
      'becomeNewPrimary should register a SIGWINCH handler',
    );
  });

  it('SIGWINCH handler resizes all emulators via emulators.values()', () => {
    // Extract the sigwinchHandler body to verify it iterates emulators
    const sigwinchMatch = body.match(/const sigwinchHandler[\s\S]*?process\.on\('SIGWINCH'/);
    assert.ok(sigwinchMatch, 'Should find sigwinchHandler definition');
    assert.ok(
      sigwinchMatch[0].includes('emulators.values()'),
      'SIGWINCH handler should iterate emulators.values() to resize all session emulators',
    );
  });
});
