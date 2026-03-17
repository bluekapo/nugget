import type { Directive, ParseResult } from './types.js';
import { logDebug } from '../logging/logger.js';

/**
 * Regex matching directive keyword lines that should terminate continuation collection.
 * Prevents CONTEXT continuation from swallowing COMMAND/ESCALATE/DONE/etc. text
 * when rendered under a single ● bullet in Claude Code TUI.
 */
const DIRECTIVE_KEYWORD_RE = /^(COMMAND|ESCALATE|DONE|SELECT|CONTEXT):\s|^(ENTER|CLEAR|RESET|YES|NO)\s*$/;

/**
 * Split lines where terminal wrapping placed a directive keyword mid-line.
 *
 * Claude Code TUI (Ink) wraps long text at terminal column width. When CONTEXT
 * and COMMAND are rendered under a single ● bullet, the COMMAND keyword can end
 * up mid-line after padding spaces:
 *   "communication.                    COMMAND: What is the project structure"
 *
 * This function splits such lines so each directive keyword starts its own line,
 * enabling the existing start-of-line matchers to find them.
 */
function splitMidLineDirectives(text: string): string {
  // Lookahead: split at 2+ whitespace chars followed by a directive keyword.
  // The lookahead keeps the keyword attached to the right-hand part.
  // Handles both colon-directives (COMMAND: ...) and bare keywords (CLEAR, ENTER, etc.)
  // at end of line — bare keywords appear at line-end when terminal wrapping places them
  // after padding spaces following CONTEXT continuation text.
  const midLineRe = /\s{2,}(?=(?:COMMAND|ESCALATE|DONE|SELECT|CONTEXT):\s|(?:ENTER|CLEAR|RESET|YES|NO)\s*$)/;

  return text.split('\n').flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed) return [line];

    const match = trimmed.match(midLineRe);
    if (match && match.index && match.index > 0) {
      const before = trimmed.substring(0, match.index);
      const after = trimmed.substring(match.index).trim();
      return [before, after];
    }
    return [line];
  }).join('\n');
}

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
  logDebug(`[directive-parser] parseDirective(${text.length} chars)`);
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
 * Stops at empty lines, new bullets (●), completion markers (✻), prompts (❯),
 * separator lines (───), or directive keywords.
 */
function collectContinuation(firstLine: string, lines: string[], startIdx: number): string {
  const parts = [firstLine];

  for (let j = startIdx + 1; j < lines.length; j++) {
    const raw = lines[j];
    const contTrimmed = raw.trim();

    // Stop at empty lines, new bullets, prompts, separator lines, directive keywords,
    // or completion markers (✻ Crunched/Brewed/Forged for Xm Ys)
    if (!contTrimmed || /^[●❯✻✶✽✢]/.test(contTrimmed) || /^[·*]\s+\w+/.test(contTrimmed) || /^─{3,}/.test(contTrimmed)) break;
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

  // ENTER (tolerates trailing whitespace/NBSP from Ink TUI cursor artifacts)
  if (/^ENTER[\s\u00A0]*$/.test(line)) {
    return { type: 'ENTER' };
  }

  // YES (tolerates trailing whitespace/NBSP)
  if (/^YES[\s\u00A0]*$/.test(line)) {
    return { type: 'YES' };
  }

  // NO (tolerates trailing whitespace/NBSP)
  if (/^NO[\s\u00A0]*$/.test(line)) {
    return { type: 'NO' };
  }

  // CLEAR (tolerates trailing whitespace/NBSP)
  if (/^CLEAR[\s\u00A0]*$/.test(line)) {
    return { type: 'CLEAR' };
  }

  // RESET (tolerates trailing whitespace/NBSP)
  if (/^RESET[\s\u00A0]*$/.test(line)) {
    return { type: 'RESET' };
  }

  // WAIT (removed directive -- return null so it triggers normal retry/parse-failure flow)
  if (/^WAIT[\s\u00A0]*$/.test(line)) return null;
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
 * Scans BACKWARD for the LAST line matching `● CONTEXT:` with the ● prefix.
 * This handles Ink TUI multi-repaint buffers where earlier repaints contain
 * partial context text — the last repaint has the complete context.
 * Collects indented continuation lines below it (same pattern as directives).
 * Returns the joined context string, or null if no CONTEXT: block found.
 */
export function parseContextBlock(text: string): string | null {
  const lines = splitMidLineDirectives(text).split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
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
  logDebug(`[directive-parser] parseDirectiveWithContext(${text.length} chars)`);
  // Normalize mid-line directive keywords caused by terminal wrapping before
  // any parsing. This ensures COMMAND:/ESCALATE:/DONE: start their own lines
  // even when the TUI wrapped them after CONTEXT continuation text.
  const normalized = splitMidLineDirectives(text);

  const directive = parseDirective(normalized);
  const context = parseContextBlock(normalized);

  // When a ● CONTEXT block exists, always try the relaxed parser and prefer its
  // result. In follow-up cycles (no /clear), old ● COMMAND from previous cycles
  // persists in Ink TUI repaints. parseDirective finds the stale directive, but
  // the current cycle's directive sits on a non-● line under the CONTEXT bullet.
  // The relaxed parser finds it correctly.
  if (context !== null) {
    const relaxedDirective = parseDirectiveRelaxed(normalized);
    return {
      directive: relaxedDirective ?? directive,
      context,
    };
  }

  return { directive, context };
}
