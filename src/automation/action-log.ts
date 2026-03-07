import type { ActionEntry } from './types.js';

export class ActionLog {
  constructor(maxEntries?: number) {
    // stub
  }

  add(action: string, outcome: string): void {
    // stub
  }

  getRecent(limit?: number): ActionEntry[] {
    return [];
  }

  get length(): number {
    return 0;
  }

  clear(): void {
    // stub
  }
}
