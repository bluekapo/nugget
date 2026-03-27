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
    redrawDelay?: number;
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
    // Advance 800ms to account for redraw-aware debounce (cursor-positioning detected)
    await capture.onData('\x1b[H\x1b[2Jnew screen content\r\nfully replaced');
    timer.advance(800);

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
    assert.equal(timer.pendingCount, 2, 'Two pending timers (debounce + exec-idle)');

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
    // Advance 800ms to account for redraw-aware debounce (cursor-positioning detected)
    await capture.onData('\x1b[H\x1b[2Jtotally different');
    timer.advance(800);

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

    // Write data containing the "Crunched for" marker AND bare ❯ prompt (Claude is idle)
    await capture.onData('\u273B Crunched for 1m 22s\r\n\u276F \r\n');
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

    await capture.onData('\u273B Crunched for 8s\r\n\u276F \r\n');
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

    await capture.onData('\u273B Brewed for 2m 15s\r\n\u276F \r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'onPromptComplete should fire for "Brewed for"');
  });

  it('completion detection: fires for "Crafted for" verb with no minutes', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    await capture.onData('\u273B Crafted for 45s\r\n\u276F \r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'onPromptComplete should fire for "Crafted for"');
  });

  it('completion detection: fires for "Forged for" verb', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    await capture.onData('\u273B Forged for 3m 5s\r\n\u276F \r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'onPromptComplete should fire for "Forged for"');
  });

  it('completion detection: does NOT re-fire for same marker after markInputSent and new output', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write data containing the "Crunched for" marker AND bare ❯ prompt
    await capture.onData('\u273B Crunched for 2m 30s\r\n\u276F \r\n');
    timer.advance(50); // debounce fires, capture runs, crunched=true, idle timer starts
    timer.advance(200); // idle fires -> onPromptComplete fires
    assert.equal(completionFired, true, 'onPromptComplete should fire first time');

    // Reset tracking
    completionFired = false;

    // User sends new input
    capture.markInputSent();

    // New output arrives but old marker is still in the screen buffer (no ❯ — processing)
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

    // First completion with bare ❯ prompt
    await capture.onData('\u273B Crunched for 2m 30s\r\n\u276F \r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'should fire for first marker');

    // Reset tracking and mark input sent
    completionFired = false;
    capture.markInputSent();

    // New output with a DIFFERENT completion marker and bare ❯ prompt
    await capture.onData('some output\r\n\u273B Brewed for 1m 15s\r\n\u276F \r\n');
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

  // ---------- Spinner guard: bare prompt indicator scenarios ----------

  it('completion detection: fires for "Baked for 40s" with bare prompt indicator on separate line', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Completion marker on one line, bare prompt indicator (\u273B) on the next, plus ❯ idle prompt
    await capture.onData('\u273B Baked for 40s\r\n\u273B\r\n\u276F \r\n');
    timer.advance(50); // debounce fires, capture runs, crunched=true, idle timer starts
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'onPromptComplete should fire for "Baked for 40s" with bare prompt indicator');
  });

  it('completion detection: fires for completion marker with short TUI artifact (non-whitespace) after prompt indicator', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Completion marker + prompt indicator with a short non-whitespace TUI artifact
    // (e.g., cursor remnant ">") that survives translateToString(true) trimming.
    // Plus bare ❯ idle prompt for ENG-03 guard.
    await capture.onData('\u273B Crafted for 12s\r\n\u273B >\r\n\u276F \r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'onPromptComplete should fire for prompt indicator with short TUI artifact');
  });

  it('completion detection: fires for prompt indicator with single non-ws char after marker', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Single non-whitespace character after marker (cursor fragment), plus bare ❯ idle prompt
    await capture.onData('\u273B Baked for 40s\r\n\u273B.\r\n\u276F \r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, true, 'onPromptComplete should fire for prompt indicator with single non-ws char');
  });

  it('completion detection: guard still blocks real spinners after completion marker (regression)', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Completion marker + active spinner (substantial text after marker)
    await capture.onData('\u273B Baked for 40s\r\n\u273B Analyzing code...\r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires
    assert.equal(completionFired, false, 'onPromptComplete should NOT fire while real spinner is active');
  });

  // ---------- Prompt-based completion detection (❯) ----------

  it('prompt detection: idle ❯ on its own line does NOT trigger onPromptComplete', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write idle prompt: ❯ followed by space on its own line
    await capture.onData('\u276F \r\n');
    timer.advance(50);  // debounce fires, capture runs
    timer.advance(200); // idle delay elapses

    assert.equal(completionFired, false, 'onPromptComplete should NOT fire for idle ❯ prompt alone — only completion markers trigger');
  });

  // ---------- Idle timer starvation (invisible PTY data) ----------

  it('completion detection: fires despite periodic invisible PTY data after marker', async () => {
    createCapture({ baseDelay: 50, idleDelay: 500 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write data with completion marker and bare ❯ idle prompt
    await capture.onData('\u273B Crunched for 1m 22s\r\n\u276F \r\n');
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

  it('completion detection: idle ❯ prompt with invisible PTY data does NOT trigger onPromptComplete', async () => {
    createCapture({ baseDelay: 50, idleDelay: 500 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Write idle prompt (no completion marker)
    await capture.onData('response text\r\n\u276F \r\n');
    timer.advance(50); // debounce fires

    // Simulate cursor blinks
    for (let i = 0; i < 12; i++) {
      await capture.onData('\x1b[H');
      timer.advance(100);
    }

    assert.equal(completionFired, false,
      'onPromptComplete should NOT fire for ❯ prompt — only completion markers trigger');
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

  // ---------- ENG-03: ❯ prompt-visibility guard ----------

  it('ENG-03: no ❯ line visible blocks onPromptComplete even with completion marker', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Completion marker present, but NO bare ❯ prompt visible on screen
    // This simulates mid-automation: marker appears but Claude is still processing
    await capture.onData('\u273B Crunched for 1m 22s\r\nSome other output\r\n');
    timer.advance(50); // debounce fires, crunched=true, idle timer starts
    timer.advance(200); // idle fires

    assert.equal(completionFired, false,
      'onPromptComplete should NOT fire when ❯ prompt is not visible on screen');
  });

  it('ENG-03: bare ❯ line on screen allows onPromptComplete to fire', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Completion marker AND bare ❯ prompt visible — Claude is truly idle
    await capture.onData('\u273B Crunched for 1m 22s\r\n\u276F \r\n');
    timer.advance(50); // debounce fires, crunched=true, idle timer starts
    timer.advance(200); // idle fires

    assert.equal(completionFired, true,
      'onPromptComplete should fire when ❯ prompt is visible on screen');
  });

  it('ENG-03: requireMarker=false skips ❯ guard (clear path)', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };
    capture.requireMarker = false;

    // No completion marker, no ❯ prompt — but requireMarker=false should skip guard
    await capture.onData('Some output after /clear\r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires

    assert.equal(completionFired, true,
      'onPromptComplete should fire with requireMarker=false even without ❯ prompt');
  });

  it('ENG-03: ❯ in SELECT menu line does NOT count as idle prompt', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Completion marker present, but ❯ appears as part of a SELECT menu option, not as bare prompt
    await capture.onData('\u273B Crunched for 1m 22s\r\n\u276F Some option text\r\nAnother option\r\n');
    timer.advance(50); // debounce fires, crunched=true, idle timer starts
    timer.advance(200); // idle fires

    assert.equal(completionFired, false,
      'onPromptComplete should NOT fire when ❯ is part of a SELECT menu line, not a bare prompt');
  });

  it('ENG-03: existing hasActiveSpinner guard still blocks for ✻ spinners (regression)', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Completion marker + active ✻ spinner on another line + bare ❯ visible
    // Even with ❯ visible, the spinner guard should still block
    await capture.onData('\u273B Crunched for 1m 22s\r\n\u273B Working on code...\r\n\u276F \r\n');
    timer.advance(50); // debounce fires
    timer.advance(200); // idle fires

    assert.equal(completionFired, false,
      'onPromptComplete should NOT fire when ✻ spinner is active, even if ❯ is visible');
  });

  // ---------- setLastFiredMarker dedup ----------

  it('setLastFiredMarker: same marker after seed does NOT trigger onPromptComplete', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Simulate a prior completion that already fired: seed the dedup marker
    // with the exact text that will appear in the screen output.
    const markerText = '\u273B Crunched for 2m 15s';
    capture.setLastFiredMarker(markerText);

    // The same marker appears in screen output (e.g. after session switch + redraw)
    await capture.onData(markerText + '\r\n\u276F \r\n');
    timer.advance(50);  // debounce fires
    timer.advance(200); // idle delay elapses

    assert.equal(completionFired, false,
      'onPromptComplete should NOT fire when the same marker was already seeded via setLastFiredMarker');
  });

  it('setLastFiredMarker: different marker after seed DOES trigger onPromptComplete', async () => {
    createCapture({ baseDelay: 50, idleDelay: 200 });
    let completionFired = false;
    capture.onPromptComplete = () => { completionFired = true; };

    // Seed a prior marker (markerA)
    const markerA = '\u273B Crunched for 2m 15s';
    capture.setLastFiredMarker(markerA);

    // A different marker (markerB) now appears — this is new work completing
    const markerB = '\u273B Brewed for 45s';
    await capture.onData(markerA + '\r\n' + markerB + '\r\n\u276F \r\n');
    timer.advance(50);  // debounce fires
    timer.advance(200); // idle delay elapses

    assert.equal(completionFired, true,
      'onPromptComplete SHOULD fire when a different marker appears after setLastFiredMarker');
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

  // ---------- OUT-01: Redraw-aware debounce ----------

  describe('OUT-01: Redraw-aware debounce', () => {
    it('OUT-01a: REDRAW_RE matches cursor-positioning sequences', () => {
      // Access the private static regex via bracket notation
      const REDRAW_RE = (ScreenCapture as any).REDRAW_RE as RegExp;

      assert.ok(REDRAW_RE.test('\x1b[1A'), 'should match cursor up ESC[1A');
      assert.ok(REDRAW_RE.test('\x1b[2K'), 'should match erase line ESC[2K');
      assert.ok(REDRAW_RE.test('\x1b[H'), 'should match cursor home ESC[H');
      assert.ok(REDRAW_RE.test('\x1b[3;5H'), 'should match cursor position ESC[3;5H');
      assert.ok(REDRAW_RE.test('\x1b[2J'), 'should match erase display ESC[2J');
      assert.ok(REDRAW_RE.test('\x1b[5B'), 'should match cursor down ESC[5B');
    });

    it('OUT-01b: REDRAW_RE does NOT match color/SGR codes', () => {
      const REDRAW_RE = (ScreenCapture as any).REDRAW_RE as RegExp;

      assert.equal(REDRAW_RE.test('\x1b[31m'), false, 'should NOT match red ESC[31m');
      assert.equal(REDRAW_RE.test('\x1b[0m'), false, 'should NOT match reset ESC[0m');
      assert.equal(REDRAW_RE.test('\x1b[1;32m'), false, 'should NOT match bold green ESC[1;32m');
      assert.equal(REDRAW_RE.test('hello world'), false, 'should NOT match plain text');
    });

    it('OUT-01c: cursor-positioning data uses redrawDelay instead of baseDelay', async () => {
      createCapture({ baseDelay: 50, redrawDelay: 400, burstThreshold: 100 });

      await capture.onData('\x1b[2K\x1b[1Anew content');

      // At 50ms (baseDelay), no event should fire because redrawDelay=400 is active
      timer.advance(50);
      assert.equal(events.length, 0, 'No event at baseDelay when redraw detected');

      // At 400ms (redrawDelay), event should fire
      timer.advance(350);
      assert.equal(events.length, 1, 'Event fires at redrawDelay');
    });

    it('OUT-01d: normal text without cursor escapes uses baseDelay', async () => {
      createCapture({ baseDelay: 50, redrawDelay: 400, burstThreshold: 100 });

      await capture.onData('normal text');

      // At 50ms (baseDelay), event should fire
      timer.advance(50);
      assert.equal(events.length, 1, 'Event fires at baseDelay for normal text');
    });

    it('OUT-01e: redrawDetected resets after capture fires', async () => {
      createCapture({ baseDelay: 50, redrawDelay: 400, burstThreshold: 100 });

      // Send redraw data
      await capture.onData('\x1b[2Kredraw data');
      timer.advance(400); // capture fires, flag should reset
      assert.equal(events.length, 1, 'First capture fires at redrawDelay');

      // Now send normal text — should use baseDelay (50ms), not redrawDelay (400ms)
      await capture.onData('normal text after redraw');
      timer.advance(50);
      assert.equal(events.length, 2, 'Second capture fires at baseDelay after flag reset');
    });

    it('OUT-01f: simulated Ink redraw produces clean capture', async () => {
      createCapture({ baseDelay: 50, redrawDelay: 400, burstThreshold: 100 });

      // Write initial content and let it capture
      await capture.onData('old line 1\r\nold line 2\r\nold line 3');
      timer.advance(50);
      assert.equal(events.length, 1, 'Initial capture');

      // Simulate Ink redraw: erase 3 lines (ESC[2K+ESC[1A repeated) then write new content
      await capture.onData('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[Gnew clean content\r\nsecond line');
      timer.advance(400); // wait for redrawDelay

      assert.equal(events.length, 2, 'Should produce second capture after redraw');
      const lastEvent = events[events.length - 1];
      assert.ok(
        lastEvent.text.includes('new clean content'),
        `Capture should contain "new clean content", got: "${lastEvent.text}"`,
      );
      assert.ok(
        lastEvent.text.includes('second line'),
        `Capture should contain "second line", got: "${lastEvent.text}"`,
      );
    });
  });

  // ---------- Scroll content cleaning (cleanViewportText integration) ----------

  it('scrollUp emits cleaned viewport text with stacked separators collapsed', async () => {
    createCapture({ baseDelay: 50 });

    // Write enough lines to fill scrollback, including stacked separators
    // that will be in the viewport after scrolling up
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`content line ${i}`);
    }
    // Add stacked separator lines (Ink TUI artifact)
    lines.push('───────────────────');
    lines.push('───────────────────');
    lines.push('───────────────────');
    lines.push('after separators');
    // Fill remaining to push content into scrollback
    for (let i = 0; i < 20; i++) {
      lines.push(`filler line ${i}`);
    }

    await capture.onData(lines.join('\r\n'));
    timer.advance(50); // let initial capture fire
    events.length = 0; // clear initial events

    // Scroll up to see the separator region
    capture.scrollUp();

    assert.equal(events.length, 1, 'scrollUp should emit one event');
    const text = events[0].text;

    // Count separator lines in emitted text -- should be at most 1 consecutive
    const emittedLines = text.split('\n');
    let maxConsecutiveSeps = 0;
    let currentRun = 0;
    for (const line of emittedLines) {
      if (/^[─━═\-]{3,}/.test(line.trim())) {
        currentRun++;
        maxConsecutiveSeps = Math.max(maxConsecutiveSeps, currentRun);
      } else {
        currentRun = 0;
      }
    }
    assert.ok(
      maxConsecutiveSeps <= 1,
      `Expected at most 1 consecutive separator line, found ${maxConsecutiveSeps} in: ${text}`,
    );
  });

  it('scrollDown emits cleaned viewport text', async () => {
    createCapture({ baseDelay: 50 });

    // Write content with stacked separators
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`line ${i}`);
    }
    lines.push('───────────────────');
    lines.push('───────────────────');
    lines.push('───────────────────');
    for (let i = 0; i < 10; i++) {
      lines.push(`more line ${i}`);
    }

    await capture.onData(lines.join('\r\n'));
    timer.advance(50);
    events.length = 0;

    // Scroll up first, then down
    capture.scrollUp();
    capture.scrollUp();
    events.length = 0;

    capture.scrollDown();
    assert.equal(events.length, 1, 'scrollDown should emit one event');
    const text = events[0].text;

    // Verify cleaning was applied -- no stacked separators
    const emittedLines = text.split('\n');
    let maxConsecutiveSeps = 0;
    let currentRun = 0;
    for (const line of emittedLines) {
      if (/^[─━═\-]{3,}/.test(line.trim())) {
        currentRun++;
        maxConsecutiveSeps = Math.max(maxConsecutiveSeps, currentRun);
      } else {
        currentRun = 0;
      }
    }
    assert.ok(
      maxConsecutiveSeps <= 1,
      `Expected at most 1 consecutive separator in scrollDown, found ${maxConsecutiveSeps}`,
    );
  });

  it('toggleLock re-lock emits cleaned screen text', async () => {
    createCapture({ baseDelay: 50 });

    // Write content including stacked separators at the bottom of the screen
    const lines: string[] = [];
    lines.push('───────────────────');
    lines.push('───────────────────');
    lines.push('───────────────────');
    lines.push('content after seps');

    await capture.onData(lines.join('\r\n'));
    timer.advance(50);
    events.length = 0;

    // Unlock then re-lock
    capture.toggleLock(); // unlock
    capture.toggleLock(); // re-lock -> should emit cleaned text

    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.mode, 'replace', 'should be replace mode');
    assert.equal(lastEvent.trigger, 'redraw', 'should be redraw trigger');

    // Check that stacked separators are collapsed
    const emittedLines = lastEvent.text.split('\n');
    let maxConsecutiveSeps = 0;
    let currentRun = 0;
    for (const line of emittedLines) {
      if (/^[─━═\-]{3,}/.test(line.trim())) {
        currentRun++;
        maxConsecutiveSeps = Math.max(maxConsecutiveSeps, currentRun);
      } else {
        currentRun = 0;
      }
    }
    assert.ok(
      maxConsecutiveSeps <= 1,
      `Expected at most 1 consecutive separator in toggleLock relock, found ${maxConsecutiveSeps}`,
    );
  });

  it('scrollDown at bottom re-locks and scrollLocked returns true', async () => {
    createCapture({ baseDelay: 50 });

    // Write enough content to have scrollback
    for (let i = 0; i < 30; i++) {
      await capture.onData(`line ${i}\r\n`);
    }
    timer.advance(50);

    // Scroll up to unlock
    capture.scrollUp();
    assert.equal(capture.scrollLocked, false, 'should be unlocked after scrollUp');

    // Scroll down repeatedly until at bottom
    for (let i = 0; i < 5; i++) {
      capture.scrollDown();
    }

    assert.equal(capture.scrollLocked, true, 'should be re-locked after scrolling to bottom');
  });

  it('scrollUp from locked state unlocks and scrollLocked returns false', async () => {
    createCapture({ baseDelay: 50 });

    // Write enough content to have scrollback
    for (let i = 0; i < 30; i++) {
      await capture.onData(`line ${i}\r\n`);
    }
    timer.advance(50);

    assert.equal(capture.scrollLocked, true, 'should start locked');

    capture.scrollUp();
    assert.equal(capture.scrollLocked, false, 'should be unlocked after scrollUp');
  });

  // ---------- swapEmulator ----------

  describe('swapEmulator', () => {
    let emulator2: TerminalEmulator;

    afterEach(() => {
      emulator2?.dispose();
    });

    it('after swapEmulator, captures read from the new emulator buffer', async () => {
      createCapture({ baseDelay: 50 });

      // Write to original emulator
      await capture.onData('original content\r\n');
      timer.advance(50);
      assert.equal(events.length, 1);
      assert.ok(events[0].text.includes('original content'));

      // Create new emulator with distinct content
      emulator2 = new TerminalEmulator(80, 24);
      await emulator2.write('new emulator content\r\n');

      // Swap to new emulator
      capture.swapEmulator(emulator2);

      // Write to new emulator via capture pipeline
      await capture.onData('post-swap data\r\n');
      timer.advance(50);

      const lastEvent = events[events.length - 1];
      assert.ok(
        lastEvent.text.includes('new emulator content') || lastEvent.text.includes('post-swap data'),
        `After swap, capture should read from new emulator, got: "${lastEvent.text}"`,
      );
    });

    it('after swapEmulator, buffer-change events come from new emulator (old disconnected)', async () => {
      createCapture({ baseDelay: 50 });

      // Write initial content so capture has something
      await capture.onData('initial\r\n');
      timer.advance(50);
      const eventsBeforeSwap = events.length;

      // Create new emulator and swap
      emulator2 = new TerminalEmulator(80, 24);
      capture.swapEmulator(emulator2);

      // Trigger alt-screen on OLD emulator -- should NOT produce event
      await emulator.write('\x1b[?1049h'); // enter alt screen
      const eventsAfterOldAlt = events.length;
      assert.equal(eventsAfterOldAlt, eventsBeforeSwap,
        'Old emulator alt-screen should NOT fire events after swap');

      // Trigger alt-screen on NEW emulator -- SHOULD produce event
      await emulator2.write('\x1b[?1049h'); // enter alt screen
      assert.ok(events.length > eventsAfterOldAlt,
        'New emulator alt-screen SHOULD fire events after swap');

      const lastEvent = events[events.length - 1];
      assert.equal(lastEvent.trigger, 'alt-enter', 'trigger should be alt-enter from new emulator');
    });

    it('swapEmulator resets diff baseline and capture state (no emulator.reset())', async () => {
      createCapture({ baseDelay: 50 });

      // Write content and capture several times to build up state
      await capture.onData('line 1\r\n');
      timer.advance(50);
      await capture.onData('line 2\r\n');
      timer.advance(50);
      assert.ok(events.length >= 2, 'should have multiple captures');

      // Unlock scroll to verify it gets reset
      capture.scrollUp();
      assert.equal(capture.scrollLocked, false, 'should be unlocked');

      // Create new emulator and swap
      emulator2 = new TerminalEmulator(80, 24);
      capture.swapEmulator(emulator2);

      // After swap: scrollLocked should be true (reset)
      assert.equal(capture.scrollLocked, true, 'scrollLocked should be reset to true after swap');

      // After swap: first capture should be 'initial' trigger (captureCount reset to 0)
      await capture.onData('fresh start\r\n');
      timer.advance(50);

      const lastEvent = events[events.length - 1];
      assert.equal(lastEvent.trigger, 'initial',
        'First capture after swap should have initial trigger (captureCount was reset)');
    });

    it('swapEmulator cancels pending debounce, idle, and exec-idle timers', async () => {
      createCapture({ baseDelay: 200, idleDelay: 500, execIdleDelay: 300 });

      // Start some data flowing to arm timers
      await capture.onData('\u273B Crunched for 1s\r\n');
      // Don't advance timer -- debounce is pending

      const eventsBeforeSwap = events.length;

      // Swap
      emulator2 = new TerminalEmulator(80, 24);
      capture.swapEmulator(emulator2);

      // Advance past all timer delays -- nothing should fire from old state
      timer.advance(1000);

      assert.equal(events.length, eventsBeforeSwap,
        'No events should fire from cancelled timers after swap');
    });

    it('after swapEmulator, scrollUp/scrollDown operate on the new emulator buffer', async () => {
      createCapture({ baseDelay: 50 });

      // Write enough content to the new emulator to enable scrollback
      emulator2 = new TerminalEmulator(80, 24);
      for (let i = 0; i < 40; i++) {
        await emulator2.write(`new-emu line ${i}\r\n`);
      }

      // Swap
      capture.swapEmulator(emulator2);

      // Write one more line via capture to ensure pipeline works
      await capture.onData('post-swap line\r\n');
      timer.advance(50);
      events.length = 0; // clear events to check scroll output

      // Scroll up on new emulator
      capture.scrollUp();
      assert.equal(events.length, 1, 'scrollUp should emit an event');

      const scrollEvent = events[0];
      assert.equal(scrollEvent.mode, 'replace', 'scroll should be replace mode');
      assert.ok(
        scrollEvent.text.includes('new-emu line'),
        `scrollUp content should come from new emulator, got: "${scrollEvent.text}"`,
      );
    });
  });
});
