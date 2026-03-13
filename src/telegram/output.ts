import { wrapPre } from '../output/html.js';
import { logError } from '../logging/logger.js';
import type { OutputEvent } from '../terminal/capture.js';

/**
 * Maximum text length per Telegram message.
 * Telegram limit is 4096 chars. Reserve space for <pre></pre> wrapper + safety margin.
 */
export const EFFECTIVE_LIMIT = 4096 - 20; // 4076

/**
 * Split text at content-aware boundaries (EMUL-05).
 *
 * Priority:
 * 1. Last newline within maxLen -- keeps logical line groups together
 * 2. Last space within maxLen (if past 50% mark) -- word boundary fallback
 * 3. Raw split at maxLen, adjusting for surrogate pairs (INTG-03)
 */
export function splitAtBoundary(text: string, maxLen: number): [string, string] {
  if (text.length <= maxLen) return [text, ''];

  const chunk = text.slice(0, maxLen);

  // Prefer newline boundary
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline > 0) {
    return [text.slice(0, lastNewline + 1), text.slice(lastNewline + 1)];
  }

  // Fallback to word boundary (only if space is past 50% of the chunk)
  const lastSpace = chunk.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    return [text.slice(0, lastSpace + 1), text.slice(lastSpace + 1)];
  }

  // Raw split -- but don't split surrogate pairs (INTG-03)
  let splitPoint = maxLen;
  const code = text.charCodeAt(splitPoint - 1);
  if (code >= 0xD800 && code <= 0xDBFF) {
    // Last char of chunk is a high surrogate -- include its low surrogate too
    splitPoint++;
  }

  return [text.slice(0, splitPoint), text.slice(splitPoint)];
}

/**
 * Delivers terminal output to Telegram as readable monospace messages.
 *
 * Pipeline: ScreenCapture -> OutputEvent -> handleEvent() -> chunk via splitAtBoundary -> sendMessage/editMessageText
 *
 * - Accepts OutputEvent objects via handleEvent()
 * - mode=append: appends text to current Telegram message
 * - mode=replace: clears current message text, writes new content
 * - Chunks text at content boundaries (newline > word > raw) via splitAtBoundary
 * - Creates a new message when the current one reaches EFFECTIVE_LIMIT
 * - Serializes all send/edit operations through a sequential async queue
 * - Suppresses "message is not modified" errors from Telegram API
 */
export class TelegramOutputSink {
  private current: { messageId: number; text: string } | null = null;

  /** Callback invoked when sendMessage creates a new Telegram message. */
  onMessageCreated: ((messageId: number) => void) | null = null;

  /** Callback invoked when a message reaches EFFECTIVE_LIMIT and is finalized. */
  onMessageCompleted: ((messageId: number, text: string) => void) | null = null;

  /** Optional function returning a header string to display above each <pre> block. */
  headerFn: (() => string | null) | null = null;

  /** Callback invoked when queue depth reaches highWaterMark (CAPT-05). */
  onHighWater: (() => void) | null = null;

  /** Callback invoked when queue depth drops to lowWaterMark after being paused (CAPT-05). */
  onLowWater: (() => void) | null = null;

  // Sequential async queue
  private queue: Promise<void> = Promise.resolve();

  // Backpressure tracking (CAPT-05)
  private pendingOps = 0;
  private paused = false;

  /** Queue depth at which onHighWater fires (CAPT-05). */
  readonly highWaterMark: number;

  /** Queue depth at which onLowWater fires after being paused (CAPT-05). */
  readonly lowWaterMark: number;

  /** Minimum milliseconds between consecutive Telegram API calls. */
  readonly minInterval: number;

  /** Timestamp of the last API call (Date.now()). */
  private lastApiCall = 0;

  constructor(
    private readonly api: {
      sendMessage(chatId: number, text: string, opts?: unknown): Promise<{ message_id: number }>;
      editMessageText(chatId: number, messageId: number, text: string, opts?: unknown): Promise<unknown>;
    },
    private readonly chatId: number,
    private readonly replyMarkup?: unknown,
    highWaterMark = 5,
    lowWaterMark = 1,
    minInterval = 350,
  ) {
    this.highWaterMark = highWaterMark;
    this.lowWaterMark = lowWaterMark;
    this.minInterval = minInterval;
  }

  /** Wait if needed to enforce minInterval between API calls. */
  private async throttle(): Promise<void> {
    if (this.minInterval <= 0) return;
    const now = Date.now();
    const elapsed = now - this.lastApiCall;
    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastApiCall = Date.now();
  }

  /**
   * Process an OutputEvent from ScreenCapture.
   *
   * - mode=replace: clears current message text, trims newlines, discards empty
   * - mode=append: appends text to current message
   */
  handleEvent(ev: OutputEvent): void {
    this.enqueueOp(async () => {
      if (ev.mode === 'replace') {
        if (this.current !== null) {
          this.current.text = '';
        }
      }

      let text = ev.text;
      if (ev.mode === 'replace') {
        text = text.replace(/^\n+/, '').replace(/\n+$/, '');
        if (text.trim().length === 0) return;
      }

      await this.sendOrEdit(text);
    });
  }

  /**
   * Returns a Promise that resolves when all queued operations have completed.
   */
  drain(): Promise<void> {
    return this.queue;
  }

  /** Returns a copy of the current message state, or null if no message is active. */
  getCurrentState(): { messageId: number; text: string } | null {
    return this.current ? { ...this.current } : null;
  }

  /** Restore message state so next output appends to the given message via editMessageText. */
  restoreState(state: { messageId: number; text: string }): void {
    this.current = { ...state };
  }

  /** Clear the current message pointer. Call on session switch to prevent stale appends. */
  clearCurrent(): void {
    this.current = null;
  }

  /** Chunking + API call logic. Uses content-aware splitting via splitAtBoundary. */
  private async sendOrEdit(text: string): Promise<void> {
    const header = this.headerFn?.() ?? null;
    let remaining = text;

    while (remaining.length > 0) {
      if (this.current === null) {
        // No current message -- create a new one
        const [chunk, rest] = splitAtBoundary(remaining, EFFECTIVE_LIMIT);
        remaining = rest;

        try {
          await this.throttle();
          const sendOpts: Record<string, unknown> = { parse_mode: 'HTML' };
          if (this.replyMarkup !== undefined) {
            sendOpts.reply_markup = this.replyMarkup;
          }
          const result = await this.api.sendMessage(
            this.chatId,
            wrapPre(chunk, header),
            sendOpts,
          );
          this.current = { messageId: result.message_id, text: chunk };
          this.onMessageCreated?.(result.message_id);
        } catch (err) {
          // Log but don't crash the pipeline
          logError('sendMessage failed:', err);
          return;
        }
      } else {
        // Current message exists -- try to append via edit
        const space = EFFECTIVE_LIMIT - this.current.text.length;

        if (space <= 0) {
          // Current message is full -- fire completed callback before nulling
          this.onMessageCompleted?.(this.current.messageId, this.current.text);
          this.current = null;
          continue;
        }

        const [chunk, rest] = splitAtBoundary(remaining, space);
        remaining = rest;
        const newText = this.current.text + chunk;

        try {
          await this.throttle();
          const editOpts: Record<string, unknown> = { parse_mode: 'HTML' };
          if (this.replyMarkup !== undefined) {
            editOpts.reply_markup = this.replyMarkup;
          }
          await this.api.editMessageText(
            this.chatId,
            this.current.messageId,
            wrapPre(newText, header),
            editOpts,
          );
          this.current.text = newText;
        } catch (err: unknown) {
          // Suppress "message is not modified" -- Telegram returns this when edit content is identical
          if (isNotModifiedError(err)) {
            this.current.text = newText;
          } else if (isMessageNotFoundError(err)) {
            // Message was deleted (e.g., during session switch). Reset and let the
            // loop iteration create a fresh message via sendMessage.
            this.current = null;
            // Put the chunk back into remaining so it gets sent in the new message
            remaining = chunk + remaining;
          } else {
            logError('editMessageText failed:', err);
            return;
          }
        }

        // If message is now full, fire completed callback before finalizing
        if (this.current && this.current.text.length >= EFFECTIVE_LIMIT) {
          this.onMessageCompleted?.(this.current.messageId, this.current.text);
          this.current = null;
        }
      }
    }
  }

  /** Enqueue an async operation to run sequentially. Tracks queue depth for backpressure (CAPT-05). */
  private enqueueOp(op: () => Promise<void>): Promise<void> {
    this.pendingOps++;
    if (!this.paused && this.pendingOps >= this.highWaterMark) {
      this.paused = true;
      this.onHighWater?.();
    }

    this.queue = this.queue
      .then(op)
      .catch((err) => {
        logError('output queue error:', err);
      })
      .finally(() => {
        this.pendingOps--;
        if (this.paused && this.pendingOps <= this.lowWaterMark) {
          this.paused = false;
          this.onLowWater?.();
        }
      });
    return this.queue;
  }
}

/** Check if an error is Telegram's "message is not modified" response. */
function isNotModifiedError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.message.includes('not modified')) return true;
    if ('description' in err && typeof (err as Record<string, unknown>).description === 'string') {
      return ((err as Record<string, unknown>).description as string).includes('not modified');
    }
  }
  return false;
}

/** Check if an error is Telegram's "message to edit not found" response. */
function isMessageNotFoundError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.message.includes('message to edit not found')) return true;
    if ('description' in err && typeof (err as Record<string, unknown>).description === 'string') {
      return ((err as Record<string, unknown>).description as string).includes('message to edit not found');
    }
  }
  return false;
}
