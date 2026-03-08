/**
 * TerminalEmulator — standalone wrapper around @xterm/headless.
 *
 * Single source of truth for terminal screen state. All PTY output flows
 * through write(), and getScreenText() extracts the rendered plain text.
 * Handles the full VT100/xterm escape sequence spec, persistent state
 * across writes, and correct text extraction.
 */

import { createRequire } from 'node:module';
import type { Terminal as TerminalType, IBufferLine } from '@xterm/headless';

import { TERMINAL_COLS, TERMINAL_ROWS } from './constants.js';

// @xterm/headless is CJS-only; use createRequire for ESM compatibility
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as { Terminal: typeof TerminalType };

export class TerminalEmulator {
  private readonly terminal: InstanceType<typeof TerminalType>;

  /**
   * Create a new TerminalEmulator with the given dimensions.
   * Defaults to TERMINAL_COLS x TERMINAL_ROWS from shared constants.
   */
  constructor(cols: number = TERMINAL_COLS, rows: number = TERMINAL_ROWS) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 500,
      allowProposedApi: true,
    });
  }

  /** Current column count. */
  get cols(): number {
    return this.terminal.cols;
  }

  /** Current row count. */
  get rows(): number {
    return this.terminal.rows;
  }

  /**
   * Write data to the terminal emulator.
   * Handles all escape sequences, cursor movement, and state updates.
   * The returned Promise resolves when the data has been fully processed.
   */
  write(data: string): Promise<void>;
  /**
   * Write data with a callback invoked synchronously when processing completes.
   * Useful when the caller needs synchronous completion notification (e.g., inside
   * a mock-timer tick where Promise microtasks don't resolve).
   */
  write(data: string, callback: () => void): void;
  write(data: string, callback?: () => void): Promise<void> | void {
    if (callback) {
      this.terminal.write(data, callback);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      try {
        this.terminal.write(data, () => resolve());
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Extract the current screen content as plain text.
   * Iterates all buffer rows, trims trailing whitespace per line,
   * and removes trailing empty lines.
   */
  getScreenText(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];

    // Only read the last `rows` lines (viewport), not the full scrollback buffer
    const startY = Math.max(0, buffer.length - this.terminal.rows);
    for (let y = startY; y < buffer.length; y++) {
      const line: IBufferLine | undefined = buffer.getLine(y);
      if (line) {
        lines.push(line.translateToString(true));
      } else {
        lines.push('');
      }
    }

    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines.join('\n');
  }

  /** Scroll the viewport by N pages (negative = up, positive = down). */
  scrollPages(count: number): void {
    this.terminal.scrollPages(count);
  }

  /** Scroll viewport to the very bottom (live position). */
  scrollToBottom(): void {
    this.terminal.scrollToBottom();
  }

  /** True when the viewport is NOT at the bottom (user has scrolled up). */
  isScrolledBack(): boolean {
    const buf = this.terminal.buffer.active;
    return buf.viewportY < buf.baseY;
  }

  /**
   * Get screen text for the CURRENT VIEWPORT position (not always the bottom).
   * When scrolled back, reads lines from viewportY to viewportY+rows.
   * When at bottom, equivalent to getScreenText().
   */
  getViewportText(): string {
    const buffer = this.terminal.buffer.active;
    const startY = buffer.viewportY;
    const lines: string[] = [];
    for (let y = startY; y < startY + this.terminal.rows; y++) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  /**
   * Check whether the terminal is currently showing the alternate screen buffer.
   * Used to detect full-screen applications (vim, less, etc.).
   */
  isAltScreen(): boolean {
    return this.terminal.buffer.active.type === 'alternate';
  }

  /**
   * Resize the terminal to new dimensions.
   * Both PTY and emulator must stay in sync via shared constants.
   */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /**
   * Register a callback for buffer change events (alt screen enter/exit).
   * The callback receives true when entering alt screen, false when exiting.
   * Returns an object with a dispose() method to unsubscribe.
   */
  onBufferChange(callback: (isAltScreen: boolean) => void): { dispose(): void } {
    const disposable = this.terminal.buffer.onBufferChange((buffer) => {
      callback(buffer.type === 'alternate');
    });
    return { dispose: () => disposable.dispose() };
  }

  /**
   * Reset terminal to initial state: clears screen, scrollback, and all internal state.
   * Use on session switch so the emulator doesn't carry stale content from the previous session.
   */
  reset(): void {
    this.terminal.reset();
  }

  /**
   * Dispose of the terminal and release resources.
   * The emulator should not be used after calling this.
   */
  dispose(): void {
    this.terminal.dispose();
  }
}
