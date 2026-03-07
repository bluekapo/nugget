import type { Directive } from './types.js';

/**
 * Parse a directive from orchestrator terminal screen text.
 *
 * Scans from the bottom of the text upward to find the LAST directive,
 * which is the orchestrator's actual response (not echoed prompt examples).
 *
 * Returns null if no valid directive is found (not an error).
 */
export function parseDirective(_screenText: string): Directive | null {
  return null; // Stub — tests should fail against this
}
