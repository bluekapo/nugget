export class RateLimiter {
  private lastSendTime = 0;
  constructor(private readonly intervalMs = 1000) {}

  canSend(mandatory: boolean): boolean {
    if (mandatory) return true;
    return Date.now() - this.lastSendTime >= this.intervalMs;
  }

  recordSend(): void {
    this.lastSendTime = Date.now();
  }
}
