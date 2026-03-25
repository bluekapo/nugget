/**
 * CompletionTracker -- lightweight per-session completion detection on raw PTY data.
 *
 * Scans raw PTY output for completion markers (the same pattern ScreenCapture uses)
 * and fires a callback when a session goes idle after detecting a marker. Designed
 * for non-active sessions where full terminal emulation (ScreenCapture) is not running.
 *
 * The active session continues to use ScreenCapture's detection with spinner guards.
 * This class handles ONLY non-active sessions.
 */

import type { TimerProvider } from './capture.js';
import { logDebug } from '../logging/logger.js';

/** Default timer using real global setTimeout/clearTimeout/Date.now */
const defaultTimer: TimerProvider = {
  setTimeout: (cb, delay) => globalThis.setTimeout(cb, delay),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

interface SessionState {
  /** Whether a completion marker was seen since last input/fire. */
  crunched: boolean;
  /** Last marker text that fired a notification -- prevents re-firing same marker. */
  lastFiredMarker: string | null;
  /** Idle timer handle. */
  idleTimer: unknown;
  /** Rolling buffer of recent raw data (last ~2000 chars) to scan for markers. */
  buffer: string;
}

/** The completion marker pattern: "\u273B <Verb> for [Xm ]Xs" (non-greedy to avoid spanning multiple markers in buffer) */
const MARKER_PATTERN = /\u273B .+? for (?:\d+m )?\d+s/g;

const BUFFER_MAX = 2000;

export class CompletionTracker {
  private sessions = new Map<string, SessionState>();
  private readonly timer: TimerProvider;
  private readonly idleDelay: number;

  /** Callback fired when a session completes (marker + idle). */
  onComplete: ((sessionName: string) => void) | null = null;

  constructor(opts?: { timer?: TimerProvider; idleDelay?: number }) {
    this.timer = opts?.timer ?? defaultTimer;
    this.idleDelay = opts?.idleDelay ?? 5000;
  }

  /**
   * Called with raw PTY data for a session.
   * Scans for completion markers and manages idle timers.
   */
  onData(sessionName: string, data: string): void {
    let state = this.sessions.get(sessionName);
    if (!state) {
      state = {
        crunched: false,
        lastFiredMarker: null,
        idleTimer: null,
        buffer: '',
      };
      this.sessions.set(sessionName, state);
    }

    // Append to rolling buffer, trim to max length from the end
    state.buffer += data;
    if (state.buffer.length > BUFFER_MAX) {
      state.buffer = state.buffer.slice(-BUFFER_MAX);
    }

    // Scan buffer for completion marker
    const matches = [...state.buffer.matchAll(MARKER_PATTERN)];
    const hasNewMarker = matches.some(m => m[0] !== state!.lastFiredMarker);
    if (hasNewMarker) {
      state.crunched = true;
    }

    // If crunched, start/restart idle timer
    if (state.crunched) {
      this.startIdleTimer(sessionName, state);
    } else {
      // Data arrived but no marker -- cancel idle timer
      this.cancelIdleTimer(state);
    }
  }

  /**
   * Reset detection state for a session (called when user sends input).
   */
  markInputSent(sessionName: string): void {
    logDebug(`[completion-tracker] markInputSent('${sessionName}')`);
    const state = this.sessions.get(sessionName);
    if (!state) return;
    state.crunched = false;
    this.cancelIdleTimer(state);
  }

  /**
   * Return the last fired marker text for a session, or null if unknown/never fired.
   * Used to carry dedup state across session switches.
   */
  getLastFiredMarker(sessionName: string): string | null {
    return this.sessions.get(sessionName)?.lastFiredMarker ?? null;
  }

  /**
   * Clean up timers and state for a session (called on session exit).
   */
  removeSession(sessionName: string): void {
    logDebug(`[completion-tracker] removeSession('${sessionName}')`);
    const state = this.sessions.get(sessionName);
    if (!state) return;
    this.cancelIdleTimer(state);
    this.sessions.delete(sessionName);
  }

  private startIdleTimer(sessionName: string, state: SessionState): void {
    this.cancelIdleTimer(state);
    state.idleTimer = this.timer.setTimeout(() => {
      state.idleTimer = null;
      if (!state.crunched) return;
      if (!this.onComplete) return;

      // Record the last marker to prevent re-firing
      const matches = [...state.buffer.matchAll(MARKER_PATTERN)];
      if (matches.length > 0) {
        state.lastFiredMarker = matches[matches.length - 1][0];
      }
      state.crunched = false;
      this.onComplete(sessionName);
    }, this.idleDelay);
  }

  private cancelIdleTimer(state: SessionState): void {
    if (state.idleTimer !== null) {
      this.timer.clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }
}
