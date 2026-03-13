import type { Transformer } from 'grammy';

/**
 * Configuration for the Telegram rate limiter.
 *
 * @property interactiveInterval - Minimum ms between interactive API calls (default: 50)
 * @property outputInterval - Minimum ms between editMessageText calls (default: 2000)
 */
export interface RateLimiterConfig {
  interactiveInterval?: number;
  outputInterval?: number;
}

interface PendingEdit {
  /** Latest payload (replaced on each coalesced call). */
  payload: unknown;
  /** All callers waiting for this edit to resolve. */
  resolvers: Array<{ resolve: (value: any) => void; reject: (err: any) => void }>;
}

/**
 * Methods that go through the interactive (fast) channel.
 * Everything else (editMessageText) goes through the output channel.
 */
const INTERACTIVE_METHODS = new Set([
  'answerCallbackQuery',
  'sendMessage',
  'deleteMessage',
  'setMyCommands',
  'getMe',
]);

/**
 * Create a grammY API transformer that enforces minimum spacing between
 * Telegram API calls using dual channels and edit coalescing.
 *
 * **Edit Coalescing:** Multiple editMessageText calls to the same
 * (chat_id, message_id) are coalesced -- only the latest payload is sent.
 * All callers receive the same result.
 *
 * **Dual-Channel Priority:**
 * - Interactive channel (50ms default): sendMessage, answerCallbackQuery, etc.
 * - Output channel (2000ms default): editMessageText.
 *
 * Install BEFORE autoRetry so throttling happens first, then retries
 * handle any 429s that still slip through:
 *
 *   bot.api.config.use(createRateLimiter());
 *   bot.api.config.use(autoRetry({ ... }));
 */
export function createRateLimiter(config: RateLimiterConfig = {}): Transformer {
  const interactiveInterval = config.interactiveInterval ?? 50;
  const outputInterval = config.outputInterval ?? 2000;

  // Separate timestamps for each channel
  let lastInteractiveCall = 0;
  let lastOutputCall = 0;

  // Separate sequential promise chains for each channel
  let interactiveQueue: Promise<void> = Promise.resolve();
  let outputQueue: Promise<void> = Promise.resolve();

  // Edit coalescing map: "chat_id:message_id" -> PendingEdit
  const pendingEdits = new Map<string, PendingEdit>();

  const transformer: Transformer = (prev, method, payload, signal) => {
    const methodStr = method as string;
    const isInteractive = INTERACTIVE_METHODS.has(methodStr);

    // Edit coalescing for editMessageText
    if (methodStr === 'editMessageText') {
      const p = payload as Record<string, unknown>;
      const chatId = p.chat_id;
      const messageId = p.message_id;

      if (chatId != null && messageId != null) {
        const key = `${chatId}:${messageId}`;
        const existing = pendingEdits.get(key);

        if (existing) {
          // Coalesce: replace payload, chain this caller's promise
          existing.payload = payload;
          return new Promise((resolve, reject) => {
            existing.resolvers.push({ resolve, reject });
          });
        }

        // First edit for this key: create pending entry and queue it
        const pending: PendingEdit = {
          payload,
          resolvers: [],
        };
        pendingEdits.set(key, pending);

        return new Promise((resolve, reject) => {
          pending.resolvers.push({ resolve, reject });

          outputQueue = outputQueue.then(async () => {
            // Enforce output interval
            const now = Date.now();
            if (lastOutputCall > 0) {
              const elapsed = now - lastOutputCall;
              if (elapsed < outputInterval) {
                await new Promise<void>(r => setTimeout(r, outputInterval - elapsed));
              }
            }

            lastOutputCall = Date.now();

            // Read the LATEST payload (may have been replaced by coalescing)
            const latestPayload = pending.payload;
            const resolvers = pending.resolvers;
            pendingEdits.delete(key);

            // Execute the actual API call
            try {
              const result = await prev(method, latestPayload as any, signal);
              for (const r of resolvers) r.resolve(result);
            } catch (err) {
              for (const r of resolvers) r.reject(err);
            }
          });
        });
      }
    }

    // Non-coalesced path: route to appropriate channel
    if (isInteractive) {
      return new Promise((resolve, reject) => {
        interactiveQueue = interactiveQueue.then(async () => {
          const now = Date.now();
          if (lastInteractiveCall > 0) {
            const elapsed = now - lastInteractiveCall;
            if (elapsed < interactiveInterval) {
              await new Promise<void>(r => setTimeout(r, interactiveInterval - elapsed));
            }
          }

          lastInteractiveCall = Date.now();

          try {
            const result = await prev(method, payload, signal);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        });
      });
    }

    // Fallback: editMessageText without chat_id/message_id (shouldn't happen) or
    // any unknown method -- route through output channel
    return new Promise((resolve, reject) => {
      outputQueue = outputQueue.then(async () => {
        const now = Date.now();
        if (lastOutputCall > 0) {
          const elapsed = now - lastOutputCall;
          if (elapsed < outputInterval) {
            await new Promise<void>(r => setTimeout(r, outputInterval - elapsed));
          }
        }

        lastOutputCall = Date.now();

        try {
          const result = await prev(method, payload, signal);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  };

  return transformer;
}
