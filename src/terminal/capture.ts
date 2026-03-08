/**
 * ScreenCapture — the middle layer in the TerminalEmulator -> ScreenCapture -> TelegramOutputSink pipeline.
 *
 * Bridges raw PTY data events to clean text OutputEvents. Feeds data to the emulator,
 * debounces rapid output with adaptive timing, takes screen snapshots via getScreenText(),
 * diffs against the last-sent snapshot, detects alt-screen transitions, and emits
 * OutputEvent objects via callback.
 */

import { TerminalEmulator } from './emulator.js';
import type { EventBus } from '../events/bus.js';

/**
 * OutputEvent — the contract between ScreenCapture and downstream consumers.
 *
 * Emitted by ScreenCapture whenever the terminal screen content changes.
 * Phase 9 will wire this to TelegramOutputSink.
 */
export interface OutputEvent {
  /** The text content to send to the consumer. */
  text: string;
  /** Whether to append to the current message or replace it entirely. */
  mode: 'append' | 'replace';
  /** What triggered this output event. */
  trigger: 'stream' | 'redraw' | 'alt-enter' | 'alt-exit' | 'initial';
}

/**
 * Timer abstraction for testability. In production, uses real setTimeout/clearTimeout.
 * In tests, inject a manual implementation to avoid conflicts with xterm's internal timers.
 */
export interface TimerProvider {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
}

/** Default timer using real global setTimeout/clearTimeout/Date.now */
const defaultTimer: TimerProvider = {
  setTimeout: (cb, delay) => globalThis.setTimeout(cb, delay),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class ScreenCapture {
  private lastSnapshot = '';
  private debounceTimer: unknown = null;
  private pendingCapture = false;
  private captureCount = 0;
  private _scrollLocked = true;

  // Adaptive debounce state
  private writeTimestamps: number[] = [];
  private readonly MAX_TIMESTAMPS = 20;
  private readonly burstThreshold: number;
  private readonly burstWindow: number;
  private readonly baseDelay: number;
  private readonly burstDelay: number;

  // maxWait cap: prevents sustained bursts from starving capture indefinitely.
  // When the first write of a burst arrives, burstStartTime records that moment.
  // If subsequent writes keep resetting the debounce timer beyond maxWait ms,
  // capture is forced immediately.
  private readonly maxWait: number;
  private burstStartTime: number | null = null;

  private readonly timer: TimerProvider;
  private readonly bufferChangeDisposable: { dispose(): void };

  // Completion detection: fires when a completion marker ("\u273B <Verb> for Xm Xs") is found
  // in terminal output AND terminal goes idle for idleDelay ms with no active spinners.
  onPromptComplete: (() => void) | null = null;
  private idleTimer: unknown = null;
  private readonly idleDelay: number;
  /** When false, onPromptComplete fires on data-idle alone without requiring a completion marker. */
  requireMarker = true;
  /** Whether a completion marker was detected in screen output. */
  private crunched = false;
  /** The last completion marker text that fired a notification — prevents re-firing for the same marker. */
  private lastFiredMarker: string | null = null;

  // Exec-state idle detection: emits 'idle' when PTY data stops flowing for execIdleDelay ms,
  // independent of completion marker detection. This drives the hub's busy/idle display.
  private execIdleTimer: unknown = null;
  private readonly execIdleDelay: number;
  private _execBusy = false;

  private readonly bus?: EventBus;
  private readonly sessionNameFn?: () => string | null;

  constructor(
    private readonly emulator: TerminalEmulator,
    private readonly onOutput: (event: OutputEvent) => void,
    opts?: {
      burstThreshold?: number;
      burstWindow?: number;
      baseDelay?: number;
      burstDelay?: number;
      maxWait?: number;
      idleDelay?: number;
      execIdleDelay?: number;
      timer?: TimerProvider;
      bus?: EventBus;
      sessionNameFn?: () => string | null;
    },
  ) {
    this.burstThreshold = opts?.burstThreshold ?? 5;
    this.burstWindow = opts?.burstWindow ?? 500;
    this.baseDelay = opts?.baseDelay ?? 150;
    this.burstDelay = opts?.burstDelay ?? 800;
    this.maxWait = opts?.maxWait ?? 3000;
    this.idleDelay = opts?.idleDelay ?? 5000;
    this.execIdleDelay = opts?.execIdleDelay ?? 3000;
    this.timer = opts?.timer ?? defaultTimer;
    this.bus = opts?.bus;
    this.sessionNameFn = opts?.sessionNameFn;

    // Subscribe to alt-screen transitions for immediate capture
    this.bufferChangeDisposable = this.emulator.onBufferChange((isAltScreen) => {
      // Cancel any pending debounce -- transition overrides it
      this.cancelTimer();
      this.pendingCapture = false;

      // Don't emit during scroll browsing
      if (!this._scrollLocked) return;

      const currentText = this.emulator.getScreenText();
      const trigger = isAltScreen ? 'alt-enter' : 'alt-exit';

      this.onOutput({
        text: currentText,
        mode: 'replace',
        trigger,
      });

      this.lastSnapshot = currentText;
      this.captureCount++;
    });
  }

  /**
   * Called when raw PTY data arrives.
   * Feeds data to the emulator and schedules a debounced capture.
   * Returns a Promise that resolves when the write is processed.
   */
  async onData(data: string): Promise<void> {
    await this.emulator.write(data);
    this.pendingCapture = true;
    this.recordWrite();
    this.scheduleCapture();
    // Only reset idle timer when no completion evidence exists.
    // When crunched is true (or requireMarker is false), invisible PTY data
    // (cursor blinks, Ink re-renders) would otherwise prevent the idle timer
    // from ever completing its idleDelay window.
    // Safety: the spinner guard in startIdleTimer() callback reads fresh
    // screen text and blocks false positives from real data arriving.
    if (!this.crunched && this.requireMarker) {
      this.cancelIdleTimer();
    }
    // Emit busy exec-state once when data starts flowing (not on every chunk)
    if (!this._execBusy) {
      this._execBusy = true;
      const name = this.sessionNameFn?.();
      if (name && this.bus) this.bus.emit('session:exec-state', name, 'busy');
    }
    // Reset exec idle timer — data is flowing, we're busy
    this.cancelExecIdleTimer();
    this.startExecIdleTimer();
  }

  /**
   * Force immediate capture of any pending data.
   * Call before session detach/exit to flush the last frame.
   */
  flush(): void {
    this.cancelTimer();
    if (this.pendingCapture) {
      this.capture();
    }
  }

  /** Whether auto-scroll is active (locked to bottom). */
  get scrollLocked(): boolean {
    return this._scrollLocked;
  }

  /** Scroll up one page. Always unlocks auto-scroll and scrolls. */
  scrollUp(): void {
    this._scrollLocked = false;
    this.emulator.scrollPages(-1);
    const text = this.emulator.getViewportText();
    this.onOutput({ text, mode: 'replace', trigger: 'redraw' });
    // Do NOT update lastSnapshot -- scroll view is transient
  }

  /** Scroll down one page and emit the viewport as a replace event. Re-locks if at bottom. */
  scrollDown(): void {
    this.emulator.scrollPages(1);
    const text = this.emulator.getViewportText();
    this.onOutput({ text, mode: 'replace', trigger: 'redraw' });
    // Do NOT update lastSnapshot -- scroll view is transient

    // Re-lock auto-scroll when user has scrolled all the way back to the bottom
    if (!this._scrollLocked && !this.emulator.isScrolledBack()) {
      this._scrollLocked = true;
    }
  }

  /** Toggle scroll lock. When re-locking, scroll to bottom and capture fresh. */
  toggleLock(): void {
    this._scrollLocked = !this._scrollLocked;
    if (this._scrollLocked) {
      // Re-locking: scroll to bottom and emit current screen
      if (this.emulator.isScrolledBack()) {
        this.emulator.scrollToBottom();
      }
      const text = this.emulator.getScreenText();
      this.onOutput({ text, mode: 'replace', trigger: 'redraw' });
      this.lastSnapshot = text;
    }
  }

  /**
   * Reset diff baseline AND clear the emulator. Call on session switch so the next
   * capture starts fresh. Without clearing the emulator, it would still hold the old
   * session's screen content, causing getScreenText() to return stale data mixed with
   * new session output.
   */
  resetBaseline(): void {
    this.cancelTimer();
    this.cancelIdleTimer();
    this.cancelExecIdleTimer();
    this.pendingCapture = false;
    this.emulator.reset();
    this.lastSnapshot = '';
    this.captureCount = 0;
    this._scrollLocked = true;
    this.crunched = false;
    this.requireMarker = true;
    this.lastFiredMarker = null;
    this._execBusy = false;
  }

  /**
   * Call when user sends input TO the PTY (e.g. from Telegram or stdin).
   * Resets completion detection so we don't fire a notification right after
   * the user sends a new prompt.
   */
  markInputSent(): void {
    this.crunched = false;
    this.cancelIdleTimer();
    this.cancelExecIdleTimer();
    this._execBusy = true;
    const name = this.sessionNameFn?.();
    if (name && this.bus) this.bus.emit('session:exec-state', name, 'busy');
  }

  /**
   * Dispose of all timers and event subscriptions.
   * The ScreenCapture should not be used after calling this.
   */
  dispose(): void {
    this.cancelTimer();
    this.cancelIdleTimer();
    this.cancelExecIdleTimer();
    this.pendingCapture = false;
    this.bufferChangeDisposable.dispose();
  }

  private scheduleCapture(): void {
    const now = this.timer.now();

    // Track when the current burst of un-captured writes began
    if (this.burstStartTime === null) {
      this.burstStartTime = now;
    }

    // maxWait cap: if we've been deferring capture for too long, force it now
    if (now - this.burstStartTime >= this.maxWait) {
      this.capture();
      // Start a fresh maxWait window for any subsequent writes
      this.burstStartTime = now;
    }

    // Schedule normal debounce timer (whether or not maxWait just fired,
    // so that trailing data after the forced capture still gets picked up)
    this.cancelTimer();
    const delay = this.getAdaptiveDelay();
    this.debounceTimer = this.timer.setTimeout(() => this.capture(), delay);
  }

  private cancelTimer(): void {
    if (this.debounceTimer !== null) {
      this.timer.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private getAdaptiveDelay(): number {
    const now = this.timer.now();
    // Count recent writes within burst window
    const recentCount = this.writeTimestamps.filter(
      (t) => now - t < this.burstWindow,
    ).length;
    return recentCount >= this.burstThreshold ? this.burstDelay : this.baseDelay;
  }

  private recordWrite(): void {
    const now = this.timer.now();
    this.writeTimestamps.push(now);
    // Prune old entries to prevent memory leak
    if (this.writeTimestamps.length > this.MAX_TIMESTAMPS) {
      this.writeTimestamps = this.writeTimestamps.slice(-this.MAX_TIMESTAMPS);
    }
  }

  private capture(): void {
    if (!this.pendingCapture) return;
    this.pendingCapture = false;
    this.burstStartTime = null;

    // When scroll is unlocked, user is browsing history -- don't update Telegram.
    // Data is already in the emulator from onData(). Re-locking via toggleLock()
    // triggers a fresh replace event with current content.
    if (!this._scrollLocked) return;

    // Auto-reset to bottom on new PTY data only when scroll is locked (auto-scroll mode).
    // When unlocked, the user is browsing history -- don't drag them back to bottom.
    // getScreenText() still reads the real bottom content regardless of viewport position.
    if (this._scrollLocked && this.emulator.isScrolledBack()) {
      this.emulator.scrollToBottom();
    }

    const currentText = this.emulator.getScreenText();

    // EMUL-04: Skip output emission if unchanged, but still restart
    // the idle timer when a completion marker was already detected.
    // Without this, invisible PTY data (cursor moves, Ink re-renders)
    // cancels the idle timer in onData() and this early return prevents
    // it from restarting — causing the engine to stall at waiting-response.
    if (currentText === this.lastSnapshot) {
      // EMUL-04: Only start idle timer if one isn't already running.
      // Restarting on every identical capture would extend the delay
      // indefinitely when invisible PTY data (cursor blinks) keeps
      // triggering capture() without changing visible content.
      if ((this.crunched || !this.requireMarker) && this.idleTimer === null) {
        this.startIdleTimer();
      }
      return;
    }

    // Determine trigger and mode
    if (this.captureCount === 0) {
      // First ever capture
      this.onOutput({ text: currentText, mode: 'replace', trigger: 'initial' });
    } else if (
      !this.emulator.isAltScreen() &&
      currentText.startsWith(this.lastSnapshot) &&
      this.lastSnapshot.length > 0
    ) {
      // Normal mode, screen grew -- extract only the new content
      const newContent = currentText.slice(this.lastSnapshot.length);
      if (newContent.length > 0) {
        this.onOutput({ text: newContent, mode: 'append', trigger: 'stream' });
      }
    } else {
      // Screen was rewritten (scroll, clear, etc.) -- full replace
      this.onOutput({ text: currentText, mode: 'replace', trigger: 'redraw' });
    }

    this.captureCount++;
    this.lastSnapshot = currentText;

    // Detect completion marker in the full screen snapshot.
    // Claude Code prints "\u273B <Verb> for Xm Xs" or "\u273B <Verb> for Xs" when a prompt completes.
    // The verb varies (Crunched, Brewed, Crafted, etc.) so we match the generic pattern.
    // Only set crunched=true if a marker text differs from the last fired marker,
    // preventing false positive re-fires when an old marker remains visible on screen.
    // Use matchAll to find ALL markers — the old fired marker may appear first in the buffer.
    const markerMatches = [...currentText.matchAll(/\u273B .+ for (?:\d+m )?\d+s/g)];
    const hasNewMarker = markerMatches.some(m => m[0] !== this.lastFiredMarker);
    if (hasNewMarker) {
      this.crunched = true;
    }

    // Only start idle timer when crunched — prevents false notifications on
    // arbitrary idle periods (plugin loads, output pauses, etc.).
    // When requireMarker=false, skip the crunched check and fire on data-idle alone.
    if (this.crunched || !this.requireMarker) {
      this.startIdleTimer();
    }
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      this.timer.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private startIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = this.timer.setTimeout(() => {
      this.idleTimer = null;
      if (!this.onPromptComplete) return;
      if (this.requireMarker && !this.crunched) return;

      // Subagent guard: check for active spinner (\u273B) on lines that do NOT
      // contain a completion marker. The \u273B appears on the completion line
      // itself ("\u273B Brewed for 1m 22s"), so we must exclude those.
      // Also exclude bare \u273B (with no text or only whitespace after it) —
      // that's Claude Code's idle prompt indicator, not an active spinner.
      // Read fresh screen text to minimize race condition where data arrived
      // between the last capture() and this timer firing. Using stale
      // lastSnapshot could miss newly-appeared spinners.
      const freshText = this.emulator.getScreenText();
      const lines = freshText.split('\n');
      const hasActiveSpinner = lines.some(
        (line) => line.includes('\u273B')
          && !/\u273B .+ for (?:\d+m )?\d+s/.test(line)
          && !/^\s*\u273B\s*$/.test(line),
      );

      if (hasActiveSpinner && this.requireMarker) {
        // Agents still running — reset and wait for next "Crunched for"
        // Skip this guard when requireMarker=false (e.g. /clear), where ✻
        // is just the normal Claude Code prompt indicator, not an active spinner.
        this.crunched = false;
        return;
      }

      // Record the latest marker text that triggered this notification to prevent re-firing.
      // Use matchAll and take the last match — old markers may precede the new one in the buffer.
      const firedMatches = [...freshText.matchAll(/\u273B .+ for (?:\d+m )?\d+s/g)];
      this.lastFiredMarker = firedMatches.length > 0 ? firedMatches[firedMatches.length - 1][0] : null;
      this.crunched = false;
      this.onPromptComplete();
    }, this.idleDelay);
  }

  private cancelExecIdleTimer(): void {
    if (this.execIdleTimer !== null) {
      this.timer.clearTimeout(this.execIdleTimer);
      this.execIdleTimer = null;
    }
  }

  private startExecIdleTimer(): void {
    this.cancelExecIdleTimer();
    this.execIdleTimer = this.timer.setTimeout(() => {
      this.execIdleTimer = null;
      this._execBusy = false;
      const name = this.sessionNameFn?.();
      if (name && this.bus) this.bus.emit('session:exec-state', name, 'idle');
    }, this.execIdleDelay);
  }
}
