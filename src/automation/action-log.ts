import type { ActionEntry, CompressedActionLog } from './types.js';

export class ActionLog {
  private entries: ActionEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries: number = 20) {
    this.maxEntries = maxEntries;
  }

  add(action: string, outcome: string): void {
    this.entries.push({ action, outcome, timestamp: Date.now() });
    // No hard cap -- compression via getCompressed() handles scaling
  }

  getRecent(limit?: number): ActionEntry[] {
    if (limit !== undefined) {
      return this.entries.slice(-limit);
    }
    return this.entries.slice();
  }

  getCompressed(recentCount: number = 10): CompressedActionLog {
    if (this.entries.length <= recentCount) {
      return {
        summary: null,
        recent: this.entries.slice(),
        totalCount: this.entries.length,
      };
    }

    const splitIdx = this.entries.length - recentCount;
    const oldEntries = this.entries.slice(0, splitIdx);
    const recentEntries = this.entries.slice(splitIdx);

    // Count directives by type (parse prefix before ":")
    const directiveCounts = new Map<string, number>();
    const escalateReasons: string[] = [];

    for (const entry of oldEntries) {
      const colonIdx = entry.action.indexOf(':');
      const type = colonIdx !== -1 ? entry.action.slice(0, colonIdx).trim() : entry.action.trim();
      directiveCounts.set(type, (directiveCounts.get(type) ?? 0) + 1);

      if (type === 'ESCALATE' && colonIdx !== -1) {
        escalateReasons.push(entry.action.slice(colonIdx + 1).trim());
      }
    }

    // Count outcomes
    let successful = 0;
    let failed = 0;
    let pending = 0;
    for (const entry of oldEntries) {
      const lowerOutcome = entry.outcome.toLowerCase();
      if (lowerOutcome.includes('awaiting')) {
        pending++;
      } else if (lowerOutcome.includes('failed') || lowerOutcome.includes('error')) {
        failed++;
      } else {
        successful++;
      }
    }

    // Build directive counts string
    const countParts: string[] = [];
    for (const [type, count] of directiveCounts) {
      countParts.push(`${count} ${type}${count !== 1 ? 's' : ''}`);
    }

    // Build summary
    let summary = `Summary of actions 1-${splitIdx} (${oldEntries.length} actions): ${countParts.join(', ')}. Outcomes: ${successful} successful, ${failed} failed, ${pending} pending.`;

    if (escalateReasons.length > 0) {
      summary += ` Escalations: ${escalateReasons.join('; ')}.`;
    }

    return {
      summary,
      recent: recentEntries,
      totalCount: this.entries.length,
    };
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
