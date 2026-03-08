import type { Directive } from './types.js';

/**
 * Parse a directive from orchestrator terminal screen text.
 *
 * Scans from the bottom of the text upward to find the LAST directive,
 * which is the orchestrator's actual response (not echoed prompt examples).
 *
 * Returns null if no valid directive is found (never throws).
 */
export function parseDirective(screenText: string): Directive | null {
  const lines = screenText.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    // Strip Claude Code TUI bullet prefix (● for assistant responses)
    const line = lines[i].trim().replace(/^●\s*/, '');
    if (!line) continue;

    // COMMAND: <text>
    const cmdMatch = line.match(/^COMMAND:\s+(.+)$/);
    if (cmdMatch) {
      return { type: 'COMMAND', command: cmdMatch[1].trim() };
    }

    // SELECT: <N>
    const selMatch = line.match(/^SELECT:\s+(\d+)$/);
    if (selMatch) {
      const option = parseInt(selMatch[1], 10);
      if (option >= 1) {
        return { type: 'SELECT', option };
      }
      return null;
    }

    // ENTER (exact match)
    if (line === 'ENTER') {
      return { type: 'ENTER' };
    }

    // WAIT (bare) or WAIT: <seconds>
    if (line === 'WAIT') {
      return { type: 'WAIT' };
    }
    const waitMatch = line.match(/^WAIT:\s+(\d+)$/);
    if (waitMatch) {
      return { type: 'WAIT', delaySeconds: parseInt(waitMatch[1], 10) };
    }

    // ESCALATE: <reason>
    const escMatch = line.match(/^ESCALATE:\s+(.+)$/);
    if (escMatch) {
      return { type: 'ESCALATE', reason: escMatch[1].trim() };
    }
  }

  return null;
}
