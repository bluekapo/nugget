import type { Directive } from './types.js';

/**
 * Parse a directive from orchestrator output text.
 *
 * Only matches lines with the ● prefix (Claude Code assistant responses).
 * This prevents matching echoed prompt examples (which lack ●) before the
 * real response arrives.
 *
 * For COMMAND and ESCALATE, collects indented continuation lines below the
 * directive line (Claude Code wraps long responses across multiple lines).
 *
 * Returns null if no valid directive is found (never throws).
 */
export function parseDirective(text: string): Directive | null {
  const lines = text.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Only match lines with the ● prefix (real Claude Code assistant responses)
    if (!/^●/.test(trimmed)) continue;

    const line = trimmed.replace(/^●\s*/, '');

    // COMMAND: collect continuation lines for wrapped text
    const cmdMatch = line.match(/^COMMAND:\s+(.+)$/);
    if (cmdMatch) {
      const command = collectContinuation(cmdMatch[1].trim(), lines, i);
      return { type: 'COMMAND', command };
    }

    // ESCALATE: collect continuation lines for wrapped reason
    const escMatch = line.match(/^ESCALATE:\s+(.+)$/);
    if (escMatch) {
      const reason = collectContinuation(escMatch[1].trim(), lines, i);
      return { type: 'ESCALATE', reason };
    }

    // DONE: collect continuation lines for wrapped summary
    const doneMatch = line.match(/^DONE:\s+(.+)$/);
    if (doneMatch) {
      const summary = collectContinuation(doneMatch[1].trim(), lines, i);
      return { type: 'DONE', summary };
    }

    // Single-line directives
    const directive = matchSingleLine(line);
    if (directive) return directive;
  }

  return null;
}

/**
 * Collect indented continuation lines below a directive line.
 * Stops at empty lines, new bullets (●), prompts (❯), or separator lines (───).
 */
function collectContinuation(firstLine: string, lines: string[], startIdx: number): string {
  const parts = [firstLine];

  for (let j = startIdx + 1; j < lines.length; j++) {
    const raw = lines[j];
    const contTrimmed = raw.trim();

    // Stop at empty lines, new bullets, prompts, or separator lines
    if (!contTrimmed || /^[●❯]/.test(contTrimmed) || /^─{3,}/.test(contTrimmed)) break;

    parts.push(contTrimmed);
  }

  // Join with single space, collapse multiple spaces from terminal padding
  return parts.join(' ').replace(/\s{2,}/g, ' ');
}

/** Match single-line directives (SELECT, ENTER, WAIT). */
function matchSingleLine(line: string): Directive | null {
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

  // YES (exact match)
  if (line === 'YES') {
    return { type: 'YES' };
  }

  // NO (exact match)
  if (line === 'NO') {
    return { type: 'NO' };
  }

  // WAIT (bare) or WAIT: <seconds>
  if (line === 'WAIT') {
    return { type: 'WAIT' };
  }
  const waitMatch = line.match(/^WAIT:\s+(\d+)$/);
  if (waitMatch) {
    return { type: 'WAIT', delaySeconds: parseInt(waitMatch[1], 10) };
  }

  return null;
}
