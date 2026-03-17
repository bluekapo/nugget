import { logDebug } from '../logging/logger.js';

export class RateLimiter {
  private lastSendTime = 0;
  constructor(private readonly intervalMs = 1000) {
    logDebug(`[rate-limiter] Created with interval=${intervalMs}ms`);
  }

  canSend(mandatory: boolean): boolean {
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
