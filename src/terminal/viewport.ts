/**
 * Viewport text cleaning utilities.
 *
 * Cleans raw terminal viewport text by collapsing Ink TUI rendering artifacts
 * (stacked separator lines, timer digit corruption) while preserving all
 * normal content unchanged. Used by ScreenCapture scroll methods before
 * emitting viewport text to the hub.
 */

/**
 * Detect whether a line is a separator (box-drawing, dashes, or timer-corrupted separator).
 *
 * Matches lines that are predominantly box-drawing characters (─ ━ ═ ╌ ╍) or ASCII dashes,
 * with possible interspersed digits or colons from Ink timer corruption (e.g., "1───2:34───").
 */
function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;

  // A separator line consists only of box-drawing chars, dashes, digits, colons, and whitespace.
  // Must have at least 3 box-drawing/dash characters to qualify.
  if (!/^[\u2500-\u257F\-\d:\s]+$/.test(trimmed)) return false;
  const boxChars = trimmed.replace(/[\d:\s]/g, '');
  return boxChars.length >= 3;
}

/**
 * Clean viewport text by collapsing Ink TUI rendering artifacts.
 *
 * - Consecutive separator lines (box-drawing, dashes, timer-corrupted) collapse to one
 * - Runs of 3+ blank lines collapse to max 2
 * - All other content passes through unchanged
 */
export function cleanViewportText(text: string): string {
  if (text === '') return '';

  const lines = text.split('\n');
  const result: string[] = [];
  let consecutiveBlanks = 0;

  for (const line of lines) {
    const isBlank = line.trim().length === 0;
    const isSep = !isBlank && isSeparatorLine(line);

    if (isSep) {
      // Collapse consecutive separator lines: skip if previous line was also a separator
      const prev = result.length > 0 ? result[result.length - 1] : null;
      if (prev !== null && isSeparatorLine(prev)) {
        continue;
      }
      consecutiveBlanks = 0;
      result.push(line);
    } else if (isBlank) {
      consecutiveBlanks++;
      if (consecutiveBlanks <= 2) {
        result.push(line);
      }
      // Skip if already at 2 consecutive blanks
    } else {
      consecutiveBlanks = 0;
      result.push(line);
    }
  }

  return result.join('\n');
}
