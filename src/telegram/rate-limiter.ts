import { logDebug } from '../logging/logger.js';

export class RateLimiter {
  private lastSendTime = 0;
  private backoffUntil = 0;

  constructor(private readonly intervalMs = 1000) {
    logDebug(`[rate-limiter] Created with interval=${intervalMs}ms`);
  }

  /**
   * Activate backoff for the given number of seconds.
   * If a longer backoff is already active, keeps the longer one.
   * No-op for zero or negative values.
   */
  notifyBackoff(seconds: number): void {
    if (seconds <= 0) return;
    const newBackoffUntil = Date.now() + seconds * 1000;
    if (newBackoffUntil > this.backoffUntil) {
      this.backoffUntil = newBackoffUntil;
      logDebug(`[rate-limiter] Backoff activated for ${seconds}s (until ${new Date(this.backoffUntil).toISOString()})`);
    }
  }

  /** Returns true if currently in a backoff window. */
  isInBackoff(): boolean {
    return Date.now() < this.backoffUntil;
  }

  canSend(mandatory: boolean): boolean {
    if (this.isInBackoff()) {
      const remaining = this.backoffUntil - Date.now();
      logDebug(`[rate-limiter] Blocked by backoff (${remaining}ms remaining)`);
      return false;
    }
    if (mandatory) return true;
    const elapsed = Date.now() - this.lastSendTime;
    const allowed = elapsed >= this.intervalMs;
    if (!allowed) {
      logDebug(`[rate-limiter] Rate limited (${elapsed}ms since last send, need ${this.intervalMs}ms)`);
    }
    return allowed;
  }

  recordSend(): void {
    this.lastSendTime = Date.now();
  }
}
