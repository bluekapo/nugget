import type { Transformer } from 'grammy';

/**
 * Configuration for the Telegram rate limiter.
 *
 * @property baseInterval - Minimum ms between ANY two API calls (default: 50)
 * @property methodIntervals - Per-method minimum ms overrides (e.g. editMessageText: 350)
 */
export interface RateLimiterConfig {
  baseInterval?: number;
  methodIntervals?: Record<string, number>;
}

/**
 * Create a grammY API transformer that enforces minimum spacing between
 * Telegram API calls. All calls go through a single sequential queue.
 *
 * This prevents 429 (Too Many Requests) errors by proactively throttling
 * rather than relying solely on retry-after backoff.
 *
 * Install BEFORE autoRetry so throttling happens first, then retries
 * handle any 429s that still slip through:
 *
 *   bot.api.config.use(createRateLimiter());
 *   bot.api.config.use(autoRetry({ ... }));
 */
export function createRateLimiter(config: RateLimiterConfig = {}): Transformer {
  const baseInterval = config.baseInterval ?? 50;
  const methodIntervals = config.methodIntervals ?? { editMessageText: 350 };

  // Timestamps for throttle computation
  let lastCallTimestamp = 0;
  const lastCallByMethod = new Map<string, number>();

  // Sequential promise chain -- ensures one API call at a time
  let queue: Promise<void> = Promise.resolve();

  const transformer: Transformer = (prev, method, payload, signal) => {
    // Wrap in a promise that chains onto the queue
    return new Promise((resolve, reject) => {
      queue = queue.then(async () => {
        // Compute required delay
        const now = Date.now();
        let requiredDelay = 0;

        // Base interval: time since ANY call
        const elapsedGlobal = now - lastCallTimestamp;
        if (lastCallTimestamp > 0 && elapsedGlobal < baseInterval) {
          requiredDelay = baseInterval - elapsedGlobal;
        }

        // Per-method interval: time since last call to THIS method
        const methodKey = method as string;
        const methodInterval = methodIntervals[methodKey];
        if (methodInterval !== undefined) {
          const lastMethodCall = lastCallByMethod.get(methodKey) ?? 0;
          if (lastMethodCall > 0) {
            const elapsedMethod = now - lastMethodCall;
            if (elapsedMethod < methodInterval) {
              const methodDelay = methodInterval - elapsedMethod;
              requiredDelay = Math.max(requiredDelay, methodDelay);
            }
          }
        }

        // Sleep if needed
        if (requiredDelay > 0) {
          await new Promise<void>(r => setTimeout(r, requiredDelay));
        }

        // Update timestamps AFTER sleeping (right before the actual call)
        const callTime = Date.now();
        lastCallTimestamp = callTime;
        if (methodInterval !== undefined) {
          lastCallByMethod.set(methodKey, callTime);
        }

        // Execute the actual API call
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
