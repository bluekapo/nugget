import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CompletionTracker } from '../../src/terminal/completion-tracker.js';
import type { TimerProvider } from '../../src/terminal/capture.js';

/**
 * ManualTimer -- deterministic timer for testing CompletionTracker's idle behavior.
 * Same pattern as capture.test.ts.
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

describe('CompletionTracker', () => {
  let tracker: CompletionTracker;
  let timer: ManualTimer;
  let completions: string[];

  beforeEach(() => {
    timer = new ManualTimer();
    completions = [];
    tracker = new CompletionTracker({ timer, idleDelay: 5000 });
    tracker.onComplete = (sessionName: string) => {
      completions.push(sessionName);
    };
  });

  it('detects completion marker in raw PTY data and fires callback after idle delay', () => {
    // Feed raw data containing a completion marker
    tracker.onData('alpha', 'Some output\n\u273B Brewed for 1m 22s\nMore text');

    // Should not fire immediately
    assert.equal(completions.length, 0);

    // Advance past idle delay
    timer.advance(5000);

    assert.equal(completions.length, 1);
    assert.equal(completions[0], 'alpha');
  });

  it('does NOT fire for the same marker text twice (dedup via lastFiredMarker)', () => {
    // First occurrence
    tracker.onData('alpha', '\u273B Brewed for 1m 22s');
    timer.advance(5000);
    assert.equal(completions.length, 1);

    // Same marker text again (e.g. still visible on screen)
    tracker.onData('alpha', '\u273B Brewed for 1m 22s');
    timer.advance(5000);

    // Should still be 1 -- not re-fired
    assert.equal(completions.length, 1);
  });

  it('resets detection state when markInputSent() is called for a session', () => {
    // Detect marker
    tracker.onData('alpha', '\u273B Crunched for 5s');

    // User sends input before idle timer fires
    tracker.markInputSent('alpha');

    // Advance past idle delay -- should NOT fire because input was sent
    timer.advance(5000);
    assert.equal(completions.length, 0);
  });

  it('cleans up session state on removeSession()', () => {
    // Start tracking
    tracker.onData('alpha', '\u273B Crafted for 10s');

    // Remove session before idle fires
    tracker.removeSession('alpha');

    // Advance -- should NOT fire
    timer.advance(5000);
    assert.equal(completions.length, 0);
  });

  it('idle timer resets when new data arrives before the idle delay', () => {
    // Feed marker
    tracker.onData('alpha', '\u273B Brewed for 1m 22s');

    // Advance partway
    timer.advance(3000);
    assert.equal(completions.length, 0);

    // New data arrives (resets idle timer)
    tracker.onData('alpha', 'more output');

    // Advance another 3000ms (total 6000 from start, but only 3000 from last data)
    timer.advance(3000);
    assert.equal(completions.length, 0);

    // Advance remaining 2000ms to reach 5000ms from last data
    timer.advance(2000);
    assert.equal(completions.length, 1);
  });

  it('fires for multiple different sessions independently', () => {
    // Feed markers to two sessions
    tracker.onData('alpha', '\u273B Brewed for 1m 22s');
    tracker.onData('beta', '\u273B Crunched for 5s');

    // Advance past idle delay
    timer.advance(5000);

    assert.equal(completions.length, 2);
    assert.ok(completions.includes('alpha'));
    assert.ok(completions.includes('beta'));
  });
});
