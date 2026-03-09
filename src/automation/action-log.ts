import type { ActionEntry } from './types.js';

export class ActionLog {
  private entries: ActionEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries: number = 20) {
    this.maxEntries = maxEntries;
  }

  add(action: string, outcome: string): void {
    this.entries.push({ action, outcome, timestamp: Date.now() });
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  getRecent(limit?: number): ActionEntry[] {
    if (limit !== undefined) {
      return this.entries.slice(-limit);
    }
    return this.entries.slice();
  }

  get length(): number {
    return this.entries.length;
  }

  updateLastOutcome(outcome: string): void {
    if (this.entries.length === 0) return;
    this.entries[this.entries.length - 1].outcome = outcome;
  }

  clear(): void {
    this.entries = [];
  }
}
