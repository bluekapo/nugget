import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalEmulator } from '../../src/terminal/emulator.js';
import { ScreenCapture } from '../../src/terminal/capture.js';
import type { OutputEvent, TimerProvider } from '../../src/terminal/capture.js';

/**
 * ManualTimer — a deterministic timer for testing ScreenCapture's debounce behavior.
 *
 * Uses a simple callback + delay tracking system. Calling advance(ms) fires
 * any timers whose delay has been reached. Completely decoupled from
 * xterm's internal setTimeout usage, avoiding mock timer conflicts.
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

  /** Advance time by ms, firing any due timers in chronological order. */
  advance(ms: number): void {
    const target = this._now + ms;
    while (this._now < target) {
      // Find earliest timer at or before target
      let earliest: { id: number; entry: { callback: () => void; fireAt: number } } | null =
        null;
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

  /** Number of pending timers. */
  get pendingCount(): number {
    return this._timers.size;
  }
}

describe('ScreenCapture', () => {
  let emulator: TerminalEmulator;
  let capture: ScreenCapture;
  let events: OutputEvent[];
  let timer: ManualTimer;

  beforeEach(() => {
    emulator = new TerminalEmulator(80, 24);
    events = [];
    timer = new ManualTimer();
  });

  afterEach(() => {
    capture?.dispose();
    emulator?.dispose();
  });

  function createCapture(opts?: {
    baseDelay?: number;
    burstDelay?: number;
    burstThreshold?: number;
    burstWindow?: number;
    maxWait?: number;
    idleDelay?: number;
  }): ScreenCapture {
    capture = new ScreenCapture(emulator, (e) => events.push(e), {
      ...opts,
      timer,
    });
    return capture;
  }

  // ---------- EMUL-04: Snapshot diffing ----------

  it('EMUL-04: identical consecutive screen content produces zero events on second capture', async () => {
    createCapture();

    await capture.onData('hello world');
    timer.advance(200);

    assert.equal(events.length, 1, 'First capture should emit');

    // Write the exact same content again (overwrite same position)
    await capture.onData('\x1b[Hhello world');
    timer.advance(200);

    assert.equal(events.length, 1, 'Identical content should NOT produce a second event');
  });

  // ---------- CAPT-01: Initial output ----------

  it('CAPT-01: first PTY data triggers OutputEvent after debounce with trigger initial', async () => {
    createCapture();

    await capture.onData('Welcome to Claude\r\n$ ');

    // Before debounce fires, no event
    assert.equal(events.length, 0, 'No event before debounce');

    timer.advance(200);

    assert.equal(events.length, 1, 'Should emit one event after debounce');
    assert.equal(events[0].trigger, 'initial', 'First event trigger should be initial');
  });

  it('CAPT-01: initial OutputEvent contains the welcome banner text', async () => {
    createCapture();

    await capture.onData('Welcome to Claude\r\n$ ');
    timer.advance(200);

    assert.equal(events.length, 1);
    assert.ok(
      events[0].text.includes('Welcome to Claude'),
      `Expected "Welcome to Claude" in: "${events[0].text}"`,
    );
  });

  // ---------- CAPT-02: Full-screen transitions ----------

  it('CAPT-02: full-screen redraws produce mode replace with complete screen', async () => {
    createCapture();

    // Initial content
    await capture.onData('old content here\r\n$ ');
    timer.advance(200);
    assert.equal(events.length, 1, 'Initial event');

    // Full-screen redraw: cursor home + clear screen + new content
    await capture.onData('\x1b[H\x1b[2Jnew screen content\r\nfully replaced');
    timer.advance(200);

    assert.equal(events.length, 2, 'Should emit second event after redraw');
    assert.equal(events[1].mode, 'replace', 'Redraw should be replace mode');
    assert.ok(
      events[1].text.includes('new screen content'),
      `Replace event should contain new content: "${events[1].text}"`,
    );
  });

  // ---------- CAPT-03: Alt-screen detection ----------

  it('CAPT-03: alt screen enter produces immediate OutputEvent with trigger alt-enter', async () => {
    createCapture();

    // Enter alt screen -- onBufferChange fires synchronously during write
    await capture.onData('\x1b[?1049h');

    // The onBufferChange callback fires during emulator.write(), before onData sets
    // pendingCapture. So the event should already be in the array.
    assert.equal(events.length, 1, 'Alt-enter should produce immediate event');
    assert.equal(events[0].trigger, 'alt-enter', 'Trigger should be alt-enter');
    assert.equal(events[0].mode, 'replace', 'Alt-enter should be replace mode');
  });

  it('CAPT-03: alt screen exit produces immediate OutputEvent with trigger alt-exit', async () => {
    createCapture();

    await capture.onData('\x1b[?1049h');
    assert.equal(events.length, 1, 'Alt-enter event');

    await capture.onData('\x1b[?1049l');
    assert.equal(events.length, 2, 'Alt-exit should produce another event');
    assert.equal(events[1].trigger, 'alt-exit', 'Trigger should be alt-exit');
    assert.equal(events[1].mode, 'replace', 'Alt-exit should be replace mode');
  });

  it('CAPT-03: alt screen transition cancels pending debounce timer', async () => {
    createCapture();

    // Write some normal data (schedules debounce via ManualTimer)
    await capture.onData('some output');
    assert.equal(events.length, 0, 'No event yet');
    assert.equal(timer.pendingCount, 1, 'One pending debounce timer');

    // Before debounce fires, enter alt screen
    await capture.onData('\x1b[?1049h');

    // The alt-screen transition should have cancelled pending debounce
    // and fired its own immediate event
    const altEvents = events.filter((e) => e.trigger === 'alt-enter');
    assert.equal(altEvents.length, 1, 'Should have alt-enter event');

    // Now advance past original debounce -- should NOT fire another event
    timer.advance(200);

    // After alt-enter, onData's continuation runs and schedules a new debounce.
    // But since pendingCapture was set to false by the alt handler,
    // and then set to true again by onData continuation, capture() would fire
    // but the screen content is the same as what was already captured by alt-enter.
    // EMUL-04 diff suppression kicks in -- no duplicate event.
    const streamEvents = events.filter(
      (e) => e.trigger === 'stream' || e.trigger === 'initial',
    );
    assert.equal(
      streamEvents.length,
      0,
      'Cancelled debounce should not produce stream/initial events',
    );
  });

  // ---------- CAPT-04: Adaptive debounce ----------

  it('CAPT-04: single write uses baseDelay (50ms) for debounce', async () => {
    createCapture({
      baseDelay: 50,
      burstDelay: 300,
      burstThreshold: 10,
      burstWindow: 100,
    });

    await capture.onData('single write');

    // At 49ms, no event yet
    timer.advance(49);
    assert.equal(events.length, 0, 'No event before baseDelay');

    // At 50ms, event fires
    timer.advance(1);
    assert.equal(events.length, 1, 'Event fires at baseDelay');
  });

  it('CAPT-04: burst of 10+ writes uses burstDelay (300ms)', async () => {
    createCapture({
      baseDelay: 50,
      burstDelay: 300,
      burstThreshold: 10,
      burstWindow: 100,
    });

    // Fire 12 rapid writes (ManualTimer.now() stays at 0 since we don't advance)
    for (let i = 0; i < 12; i++) {
      await capture.onData(`line ${i}\r\n`);
    }

    // At 50ms (baseDelay), should NOT fire because burst was detected
    timer.advance(50);
    assert.equal(events.length, 0, 'No event at baseDelay during burst');

    // At 299ms, still no event
    timer.advance(249);
    assert.equal(events.length, 0, 'No event before burstDelay');

    // At 300ms, event fires
    timer.advance(1);
    assert.equal(events.length, 1, 'Event fires at burstDelay');
  });

  // ---------- Coalescing ----------

  it('rapid writes coalesced into single capture', async () => {
    createCapture();

    await capture.onData('line 1\r\n');
    await capture.onData('line 2\r\n');
    await capture.onData('line 3\r\n');

    timer.advance(200);

    assert.equal(events.length, 1, 'Should coalesce into one event');
    assert.ok(events[0].text.includes('line 3'), 'Should contain latest content');
  });

  // ---------- flush() ----------

  it('flush() forces immediate capture of pending data', async () => {
    createCapture();

    await capture.onData('pending data');
    assert.equal(events.length, 0, 'No event before flush');

    capture.flush();
    assert.equal(events.length, 1, 'flush() should emit immediately');
    assert.ok(events[0].text.includes('pending data'), 'Should contain pending content');
  });

  // ---------- dispose() ----------

  it('dispose() cleans up timers and event subscriptions', async () => {
    createCapture();

    await capture.onData('some data');
    capture.dispose();

    // Advance past debounce -- should NOT fire after dispose
    timer.advance(200);
    assert.equal(events.length, 0, 'No events after dispose');

    // Mark as disposed so afterEach doesn't double-dispose
    capture = undefined as unknown as ScreenCapture;
  });

  // ---------- Append diff ----------

  it('append diff: growing normal-mode screen emits mode append with only new content', async () => {
    createCapture();

    await capture.onData('line 1');
    timer.advance(200);
    assert.equal(events.length, 1, 'Initial event');
    assert.equal(events[0].trigger, 'initial');

    // Append more content (screen grows -- new text starts where old ended)
    await capture.onData('\r\nline 2');
    timer.advance(200);

    assert.equal(events.length, 2, 'Should emit append event');
    assert.equal(events[1].mode, 'append', 'Should be append mode');
    assert.ok(
      events[1].text.includes('line 2'),
      `Append text should contain new content: "${events[1].text}"`,
    );
    // The append text should NOT contain the original content
    assert.ok(
      !events[1].text.includes('line 1'),
      'Append text should NOT contain original content',
    );
  });

  // ---------- Replace diff ----------

  it('replace diff: non-prefix screen change emits mode replace with full content', async () => {
    createCapture();

    await capture.onData('original content');
    timer.advance(200);
    assert.equal(events.length, 1, 'Initial event');

    // Write completely different content (clear and replace)
    await capture.onData('\x1b[H\x1b[2Jtotally different');
    timer.advance(200);

    assert.equal(events.length, 2, 'Should emit replace event');
    assert.equal(events[1].mode, 'replace', 'Should be replace mode');
    assert.ok(
      events[1].text.includes('totally different'),
      `Replace text should contain new content: "${events[1].text}"`,
    );
  });

  // ---------- CAPT-06: maxWait cap ----------
  //
  // These tests reproduce the sustained-burst starvation bug: when writes arrive
  // faster than burstDelay, the debounce timer resets indefinitely and capture()
  // never fires. The maxWait cap guarantees a forced capture after maxWait ms.
  //
  // Strategy: Use burstThreshold=1 so burst mode activates from the very first
  // write. With burstDelay > write interval, the timer always gets cancelled
  // before it fires, proving that only maxWait can force a capture.

  it('CAPT-06: sustained burst writes produce at least 1 capture via maxWait cap', async () => {
    createCapture({
      baseDelay: 500,     // High baseDelay so even non-burst can't fire in 100ms
      burstDelay: 500,    // burstDelay > write interval (100ms) -> timer always cancelled
      burstThreshold: 1,  // Burst from very first write
      burstWindow: 5000,  // Large window keeps all writes "recent"
      maxWait: 1000,
    });

    // 15 writes at 100ms intervals (total: 1500ms). burstDelay=500 > interval=100.
    // Each write cancels the 500ms timer and reschedules. Without maxWait, no capture
    // ever fires. With maxWait=1000, capture is forced at ~1000ms.
    for (let i = 0; i < 15; i++) {
      await capture.onData(`line ${i}\r\n`);
      timer.advance(100);
    }

    assert.ok(
      events.length >= 1,
      `Expected at least 1 event from maxWait cap, got ${events.length}`,
    );
  });

  it('CAPT-06: maxWait triggers immediate capture when elapsed exceeds threshold', async () => {
    createCapture({
      baseDelay: 500,
      burstDelay: 500,
      burstThreshold: 1,
      burstWindow: 5000,
      maxWait: 400,
    });

    // 8 writes at 100ms intervals. burstDelay=500 > interval=100 -> timer never fires.
    // maxWait=400 should force capture at ~400ms.
    for (let i = 0; i < 8; i++) {
      await capture.onData(`data ${i}\r\n`);
      timer.advance(100);
    }
    assert.ok(events.length >= 1, `maxWait should force capture at ~400ms, got ${events.length} events`);
  });

  it('CAPT-06: after maxWait forces capture, next write starts fresh maxWait window', async () => {
    createCapture({
      baseDelay: 500,
      burstDelay: 500,
      burstThreshold: 1,
      burstWindow: 10000,
      maxWait: 400,
    });

    // 12 writes at 100ms intervals (1200ms total). maxWait=400ms.
    // Should get captures at ~400ms, ~800ms, ~1200ms -> at least 2 captures.
    for (let i = 0; i < 12; i++) {
      await capture.onData(`data-${i}\r\n`);
      timer.advance(100);
    }

    assert.ok(
      events.length >= 2,
      `1200ms of writes with maxWait=400 should yield >= 2 captures, got ${events.length}`,
    );
  });

  it('CAPT-06: writes stopping before maxWait use normal debounce (no regression)', async () => {
    createCapture({
      baseDelay: 50,
      burstDelay: 300,
      burstThreshold: 3,
      burstWindow: 2000,
      maxWait: 5000, // maxWait much larger than burstDelay
    });

    // Write 4 rapid writes at t=0 (triggers burst: 4 >= threshold 3), then stop.
    for (let i = 0; i < 4; i++) {
      await capture.onData(`quick ${i}\r\n`);
    }

    // No events yet (burst debounce is 300ms, maxWait is 5000ms)
    assert.equal(events.length, 0, 'No events during burst writes');

    // Advance past burstDelay (300ms), well before maxWait
    timer.advance(300);
    assert.equal(events.length, 1, 'Normal debounce fires before maxWait');
    assert.equal(events[0].trigger, 'initial', 'Should be initial trigger (first capture)');
  });

  // ---------- Completion detection ----------

  it('completion detection: fires onPromptComplete when screen contains "Crunched for" and goes idle', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write data containing the "Crunched for" marker
    await capture.onData('\u273B Crunched for 1m 22s\r\n');
    timer.advance(50); // debounce fires, capture runs, crunched=true, idle timer starts

    // Advance past idle delay
    timer.advance(200);
    assert.equal(completionFired, true, 'onPromptComplete should fire after Crunched + idle');
  });

  it('completion detection: does NOT fire on normal idle without Crunched marker', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write normal data without "Crunched for"
    await capture.onData('Some regular output\r\n');
    timer.advance(50); // debounce fires

    // Advance well past idle delay
    timer.advance(500);
    assert.equal(completionFired, false, 'onPromptComplete should NOT fire without Crunched marker');
  });

  it('completion detection: does NOT fire while spinner is active on non-Crunched line', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write data with Crunched marker AND an active spinner on a different line
    await capture.onData('\u273B Crunched for 1m 22s\r\n\u273B Working...\r\n');
    timer.advance(50); // debounce fires

    // Advance past idle delay
    timer.advance(200);
    assert.equal(completionFired, false, 'onPromptComplete should NOT fire while spinner is active on non-Crunched line');
  });

  it('completion detection: markInputSent resets crunched state', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write data containing the "Crunched for" marker
    await capture.onData('\u273B Crunched for 1m 22s\r\n');
    timer.advance(50); // debounce fires, crunched=true

    // User sends input — resets crunched state
    capture.markInputSent();

    // Advance past idle delay
    timer.advance(200);
    assert.equal(completionFired, false, 'onPromptComplete should NOT fire after markInputSent');
  });

  it('completion detection: fires for short prompts with "Crunched for Xs" (no minutes)', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    await capture.onData('\u273B Crunched for 8s\r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'Should fire for short Crunched marker without minutes');
  });

  // ---------- toggleLock ----------

  it('toggleLock: unlocks when locked, re-locks when unlocked', async () => {
    createCapture({ baseDelay: 50 });

    // Write some initial data so emulator has content
    await capture.onData('hello world\r\n');
    timer.advance(50);
    assert.equal(events.length, 1, 'initial event');

    // Default: locked
    assert.equal(capture.scrollLocked, true, 'should start locked');

    // Toggle to unlocked
    capture.toggleLock();
    assert.equal(capture.scrollLocked, false, 'should be unlocked after first toggle');

    // Toggle back to locked -- should emit a redraw with current screen content
    const evCountBefore = events.length;
    capture.toggleLock();
    assert.equal(capture.scrollLocked, true, 'should be locked after second toggle');
    assert.ok(events.length > evCountBefore, 're-locking should emit a redraw event');
    assert.equal(events[events.length - 1].trigger, 'redraw', 'should be a redraw trigger');
  });

  // ---------- scrollUp always scrolls ----------

  it('scrollUp always scrolls without two-step unlock', async () => {
    createCapture({ baseDelay: 50 });

    // Write enough content to have scrollback
    for (let i = 0; i < 30; i++) {
      await capture.onData(`line ${i}\r\n`);
    }
    timer.advance(50);

    assert.equal(capture.scrollLocked, true, 'should start locked');

    // First scrollUp should immediately unlock AND scroll (no two-step behavior)
    capture.scrollUp();
    assert.equal(capture.scrollLocked, false, 'should be unlocked after scrollUp');
    // Should have emitted a redraw event for the scroll
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.mode, 'replace', 'scroll should emit replace');
    assert.equal(lastEvent.trigger, 'redraw', 'scroll should emit redraw trigger');
  });

  // ---------- Broadened completion detection ----------

  it('completion detection: fires for "Brewed for" verb', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    await capture.onData('\u273B Brewed for 2m 15s\r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'onPromptComplete should fire for "Brewed for"');
  });

  it('completion detection: fires for "Crafted for" verb with no minutes', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    await capture.onData('\u273B Crafted for 45s\r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'onPromptComplete should fire for "Crafted for"');
  });

  it('completion detection: fires for "Forged for" verb', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    await capture.onData('\u273B Forged for 3m 5s\r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'onPromptComplete should fire for "Forged for"');
  });

  it('completion detection: does NOT re-fire for same marker after markInputSent and new output', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write data containing the "Crunched for" marker
    await capture.onData('\u273B Crunched for 2m 30s\r\n');
    timer.advance(50); // debounce fires, capture runs, crunched=true, idle timer starts
    timer.advance(200); // idle fires -> onPromptComplete fires
    assert.equal(completionFired, true, 'onPromptComplete should fire first time');

    // Reset tracking
    completionFired = false;

    // User sends new input
    capture.markInputSent();

    // New output arrives but old marker is still in the screen buffer
    await capture.onData('new output but old marker still on screen\r\n');
    timer.advance(50); // debounce fires, capture runs — old marker still visible
    timer.advance(200); // idle fires

    // Key assertion: old marker should NOT trigger a second notification
    assert.equal(completionFired, false, 'should NOT re-fire for same marker after markInputSent');
  });

  it('completion detection: fires for NEW marker after previous marker was consumed', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // First completion
    await capture.onData('\u273B Crunched for 2m 30s\r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'should fire for first marker');

    // Reset tracking and mark input sent
    completionFired = false;
    capture.markInputSent();

    // New output with a DIFFERENT completion marker
    await capture.onData('some output\r\n\u273B Brewed for 1m 15s\r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires

    // Different marker text = new completion -> should fire
    assert.equal(completionFired, true, 'should fire for different marker text');
  });

  it('completion detection: subagent guard still works with broadened regex', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Completed line + active spinner on another line
    await capture.onData('\u273B Brewed for 1m 22s\r\n\u273B Working...\r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, false, 'should NOT fire while spinner is active on non-completion line');
  });

  // ---------- Prompt-based completion detection (❯) ----------

  it('prompt detection: ❯ on its own line triggers onPromptComplete (no marker needed)', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write idle prompt: ❯ followed by space on its own line
    await capture.onData('\u276F \r\n');
    timer.advance(50);  // debounce fires, capture runs, crunched=true via ❯ detection
    timer.advance(200); // idle fires -> onPromptComplete

    assert.equal(completionFired, true, 'onPromptComplete should fire when ❯ prompt appears on its own line');
  });

  it('prompt detection: echoed input ❯ npm test does NOT trigger completion', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write echoed input line — ❯ followed by command text
    await capture.onData('\u276F npm test\r\n');
    timer.advance(50);  // debounce fires
    timer.advance(200); // idle delay

    assert.equal(completionFired, false, 'onPromptComplete should NOT fire for echoed input line');
  });

  it('prompt detection: spinner guard blocks when ❯ prompt AND active spinner present', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write ❯ prompt AND active spinner on another line
    await capture.onData('\u276F \r\n\u273B Working...\r\n');
    timer.advance(50);  // debounce fires
    timer.advance(200); // idle fires — spinner guard should block

    assert.equal(completionFired, false, 'onPromptComplete should NOT fire when active spinner is present');
  });

  it('prompt detection: markInputSent() resets prompt-based detection', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write idle prompt
    await capture.onData('\u276F \r\n');
    timer.advance(50); // debounce fires, crunched=true via ❯ detection

    // User sends input — resets crunched state
    capture.markInputSent();

    // Advance past idle delay
    timer.advance(200);

    assert.equal(completionFired, false, 'onPromptComplete should NOT fire after markInputSent resets ❯ detection');
  });

  // ---------- Idle timer starvation (invisible PTY data) ----------

  it('completion detection: fires despite periodic invisible PTY data after marker', async () => {
    createCapture({ baseDelay: 50, idleDelay: 500 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write data with completion marker
    await capture.onData('\u273B Crunched for 1m 22s\r\n');
    timer.advance(50); // debounce fires, crunched=true, idle timer starts

    // Simulate periodic invisible PTY data (cursor repositioning)
    // These should NOT prevent the idle timer from firing
    for (let i = 0; i < 12; i++) {
      await capture.onData('\x1b[H'); // cursor home — no visible change
      timer.advance(100);
    }
    // Total: 1250ms elapsed (50 + 12*100). idleDelay=500, so timer should have fired.

    assert.equal(completionFired, true,
      'onPromptComplete should fire despite periodic invisible PTY data');
  });

  it('completion detection: fires despite invisible PTY data after idle prompt', async () => {
    createCapture({ baseDelay: 50, idleDelay: 500 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write idle prompt (no completion marker)
    await capture.onData('response text\r\n\u276F \r\n');
    timer.advance(50); // debounce fires, crunched=true via ❯ detection

    // Simulate cursor blinks
    for (let i = 0; i < 12; i++) {
      await capture.onData('\x1b[H');
      timer.advance(100);
    }

    assert.equal(completionFired, true,
      'onPromptComplete should fire for ❯ prompt despite invisible PTY data');
  });

  it('completion detection: real screen change after marker restarts idle timer', async () => {
    createCapture({ baseDelay: 50, idleDelay: 500 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Completion marker detected
    await capture.onData('\u273B Crunched for 1m 22s\r\n');
    timer.advance(50); // crunched=true, idle timer starts

    // Wait 400ms (just under idleDelay=500)
    for (let i = 0; i < 4; i++) {
      await capture.onData('\x1b[H'); // invisible
      timer.advance(100);
    }
    assert.equal(completionFired, false, 'should NOT have fired yet');

    // Now real visible data arrives (worker starts new work)
    await capture.onData('\x1b[H\x1b[2J\u273B Working on something...\r\n');
    timer.advance(50); // debounce fires, screen changed, has active spinner

    // Wait past original idle delay
    timer.advance(500);
    assert.equal(completionFired, false,
      'should NOT fire — active spinner detected on real screen change');
  });

  // ---------- Scroll lock suppresses output ----------

  it('scroll unlocked: new PTY data does NOT emit output events', async () => {
    createCapture({ baseDelay: 50 });

    // Write initial data and capture while locked
    await capture.onData('initial content\r\n');
    timer.advance(50);
    assert.equal(events.length, 1, 'initial event while locked');

    // Unlock scroll
    capture.toggleLock();
    assert.equal(capture.scrollLocked, false, 'should be unlocked');
    const eventsAfterUnlock = events.length;

    // Write new data while unlocked
    await capture.onData('new data while unlocked\r\n');
    timer.advance(50);

    assert.equal(events.length, eventsAfterUnlock, 'no new events should be emitted while scroll is unlocked');
  });

  it('scroll re-lock: emits fresh replace event with current content', async () => {
    createCapture({ baseDelay: 50 });

    // Write initial data and capture while locked
    await capture.onData('line 1\r\n');
    timer.advance(50);
    assert.equal(events.length, 1, 'initial event');

    // Unlock and write more data
    capture.toggleLock();
    await capture.onData('line 2 while unlocked\r\n');
    timer.advance(50);
    const eventsBeforeRelock = events.length;

    // Re-lock -- should emit a replace event with current screen content
    capture.toggleLock();
    assert.equal(capture.scrollLocked, true, 'should be locked again');
    assert.ok(events.length > eventsBeforeRelock, 're-locking should emit a replace event');

    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.mode, 'replace', 'should be replace mode');
    assert.equal(lastEvent.trigger, 'redraw', 'should be redraw trigger');
    assert.ok(lastEvent.text.includes('line 2 while unlocked'), 'should contain content written while unlocked');
  });

  it('CAPT-06: custom maxWait value is respected via opts', async () => {
    createCapture({
      baseDelay: 500,
      burstDelay: 500,
      burstThreshold: 1,
      burstWindow: 10000,
      maxWait: 200, // Very short maxWait
    });

    // 10 writes at 50ms intervals (500ms total). burstDelay=500 > interval=50.
    // maxWait=200 should fire at ~200ms and ~400ms -> at least 2 captures.
    for (let i = 0; i < 10; i++) {
      await capture.onData(`fast ${i}\r\n`);
      timer.advance(50);
    }

    assert.ok(
      events.length >= 2,
      `maxWait=200ms over 500ms should yield >= 2 captures, got ${events.length}`,
    );
  });
});
