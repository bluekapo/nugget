import type { Directive, ParseResult } from './types.js';

/**
 * Regex matching directive keyword lines that should terminate continuation collection.
 * Prevents CONTEXT continuation from swallowing COMMAND/ESCALATE/DONE/etc. text
 * when rendered under a single ● bullet in Claude Code TUI.
 */
const DIRECTIVE_KEYWORD_RE = /^(COMMAND|ESCALATE|DONE|SELECT|CONTEXT):\s|^(ENTER|CLEAR|RESET|YES|NO)$/;

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

    // Stop at empty lines, new bullets, prompts, separator lines, or directive keywords
    if (!contTrimmed || /^[●❯]/.test(contTrimmed) || /^─{3,}/.test(contTrimmed)) break;
    if (DIRECTIVE_KEYWORD_RE.test(contTrimmed)) break;

    parts.push(contTrimmed);
  }

  // Join with single space, collapse multiple spaces from terminal padding
  return parts.join(' ').replace(/\s{2,}/g, ' ');
}

/** Match single-line directives (SELECT, ENTER). WAIT is recognized but ignored (returns null). */
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

  // CLEAR (exact match, no parameters)
  if (line === 'CLEAR') {
    return { type: 'CLEAR' };
  }

  // RESET (exact match, no parameters)
  if (line === 'RESET') {
    return { type: 'RESET' };
  }

  // WAIT (removed directive -- return null so it triggers normal retry/parse-failure flow)
  if (line === 'WAIT') return null;
  if (/^WAIT:\s+\d+$/.test(line)) return null;

  return null;
}

/**
 * Extract a CONTEXT: block from orchestrator output text.
 *
 * CONTEXT is a modifier, not a directive. It appears alongside a directive
 * (e.g., the orchestrator response has both a COMMAND: line and a CONTEXT: line).
 * parseDirective does NOT match CONTEXT: -- this is a separate extraction.
 *
 * Scans for a line matching `● CONTEXT:` with the ● prefix.
 * Collects indented continuation lines below it (same pattern as directives).
 * Returns the joined context string, or null if no CONTEXT: block found.
 */
export function parseContextBlock(text: string): string | null {
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Only match lines with the ● prefix
    if (!/^●/.test(trimmed)) continue;

    const line = trimmed.replace(/^●\s*/, '');

    const ctxMatch = line.match(/^CONTEXT:\s+(.+)$/);
    if (ctxMatch) {
      return collectContinuation(ctxMatch[1].trim(), lines, i);
    }
  }

  return null;
}

/**
 * Relaxed directive parser for single-bullet responses.
 *
 * When Claude Code TUI renders both CONTEXT and a directive under a single ●,
 * the directive line lacks its own ● prefix. This function scans non-● lines
 * for directive patterns.
 *
 * IMPORTANT: Only called from parseDirectiveWithContext when a ● CONTEXT: block
 * is confirmed to exist. This prevents false positives from bare directive text
 * in prompt echoes.
 */
function parseDirectiveRelaxed(text: string): Directive | null {
  const lines = text.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Skip lines with ● prefix (handled by parseDirective)
    if (/^●/.test(trimmed)) continue;

    // Skip separator lines and prompt lines
    if (/^─{3,}/.test(trimmed)) continue;
    if (/^❯/.test(trimmed)) continue;

    // Try COMMAND: with continuation
    const cmdMatch = trimmed.match(/^COMMAND:\s+(.+)$/);
    if (cmdMatch) {
      const command = collectContinuation(cmdMatch[1].trim(), lines, i);
      return { type: 'COMMAND', command };
    }

    // Try ESCALATE: with continuation
    const escMatch = trimmed.match(/^ESCALATE:\s+(.+)$/);
    if (escMatch) {
      const reason = collectContinuation(escMatch[1].trim(), lines, i);
      return { type: 'ESCALATE', reason };
    }

    // Try DONE: with continuation
    const doneMatch = trimmed.match(/^DONE:\s+(.+)$/);
    if (doneMatch) {
      const summary = collectContinuation(doneMatch[1].trim(), lines, i);
      return { type: 'DONE', summary };
    }

    // Try single-line directives (ENTER, CLEAR, RESET, YES, NO, SELECT)
    const directive = matchSingleLine(trimmed);
    if (directive) return directive;
  }

  return null;
}

/**
 * Convenience function: parse both directive and context block from the same text.
 * Returns combined ParseResult with both directive and context (either may be null).
 *
 * When parseDirective returns null but a ● CONTEXT: block exists, falls back to
 * parseDirectiveRelaxed to find directives on non-● lines. This handles Claude Code
 * TUI rendering both CONTEXT and COMMAND under a single ● bullet.
 */
export function parseDirectiveWithContext(text: string): ParseResult {
  const directive = parseDirective(text);
  const context = parseContextBlock(text);

  // Fallback: if no ●-prefixed directive found but we DO have a ● CONTEXT block,
  // look for a relaxed (non-●) directive. This handles Claude Code TUI rendering
  // both CONTEXT and COMMAND under a single ● bullet.
  if (!directive && context !== null) {
    return {
      directive: parseDirectiveRelaxed(text),
      context,
    };
  }

  return { directive, context };
}
