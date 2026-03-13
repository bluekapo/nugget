import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, type RateLimiterConfig } from '../src/telegram/rate-limiter.js';

/**
 * Mock prev function that records call timestamps and returns a canned result.
 * Simulates the underlying grammY API call function.
 */
function createMockPrev() {
  const calls: { method: string; payload: unknown; timestamp: number }[] = [];
  const prev = async (method: string, payload: unknown, _signal?: AbortSignal) => {
    calls.push({ method, payload, timestamp: Date.now() });
    return { ok: true as const, result: { message_id: 1 } };
  };
  return { prev, calls };
}

describe('TelegramRateLimiter', () => {
  it('Test 1: Sequential calls are spaced at least minInterval ms apart', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = { baseInterval: 40, methodIntervals: {} };
    const transformer = createRateLimiter(config);

    // Fire 3 sequential calls
    await transformer(prev as any, 'sendMessage' as any, {} as any);
    await transformer(prev as any, 'sendMessage' as any, {} as any);
    await transformer(prev as any, 'sendMessage' as any, {} as any);

    assert.equal(calls.length, 3);
    // Each gap should be >= baseInterval (allow 20ms jitter tolerance)
    const gap1 = calls[1].timestamp - calls[0].timestamp;
    const gap2 = calls[2].timestamp - calls[1].timestamp;
    assert.ok(gap1 >= 40 - 20, `Gap 1 should be >= 20ms (was ${gap1}ms)`);
    assert.ok(gap2 >= 40 - 20, `Gap 2 should be >= 20ms (was ${gap2}ms)`);
  });

  it('Test 2: editMessageText calls get extra spacing beyond the base interval', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = {
      baseInterval: 50,
      methodIntervals: { editMessageText: 200 },
    };
    const transformer = createRateLimiter(config);

    // Two consecutive editMessageText calls
    await transformer(prev as any, 'editMessageText' as any, {} as any);
    await transformer(prev as any, 'editMessageText' as any, {} as any);

    assert.equal(calls.length, 2);
    const gap = calls[1].timestamp - calls[0].timestamp;
    // Should be at least methodInterval (200ms), allow 30ms jitter
    assert.ok(gap >= 200 - 30, `editMessageText gap should be >= 170ms (was ${gap}ms)`);
  });

  it('Test 3: Multiple concurrent calls are queued and executed in order', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = { baseInterval: 30, methodIntervals: {} };
    const transformer = createRateLimiter(config);

    // Fire 5 calls concurrently -- they should queue up, not drop
    const promises = [
      transformer(prev as any, 'sendMessage' as any, { id: 1 } as any),
      transformer(prev as any, 'sendMessage' as any, { id: 2 } as any),
      transformer(prev as any, 'sendMessage' as any, { id: 3 } as any),
      transformer(prev as any, 'sendMessage' as any, { id: 4 } as any),
      transformer(prev as any, 'sendMessage' as any, { id: 5 } as any),
    ];

    await Promise.all(promises);

    // All 5 should have executed
    assert.equal(calls.length, 5);
    // They should be in order (payloads match)
    for (let i = 0; i < 5; i++) {
      assert.deepStrictEqual(calls[i].payload, { id: i + 1 });
    }
  });

  it('Test 4: The transformer returns the result from the underlying API call', async () => {
    const prev = async (_method: string, _payload: unknown, _signal?: AbortSignal) => {
      return { ok: true as const, result: { message_id: 42 } };
    };
    const transformer = createRateLimiter({ baseInterval: 0, methodIntervals: {} });

    const result = await transformer(prev as any, 'sendMessage' as any, {} as any);
    assert.deepStrictEqual(result, { ok: true, result: { message_id: 42 } });
  });

  it('Test 5: If underlying call fails, error propagates to caller', async () => {
    const prev = async (_method: string, _payload: unknown, _signal?: AbortSignal) => {
      throw new Error('Telegram API down');
    };
    const transformer = createRateLimiter({ baseInterval: 0, methodIntervals: {} });

    await assert.rejects(
      () => transformer(prev as any, 'sendMessage' as any, {} as any),
      { message: 'Telegram API down' },
    );
  });

  it('Test 6: Default config uses 25ms base interval and no per-method overrides', async () => {
    const { prev, calls } = createMockPrev();
    // Create with NO config -- uses defaults
    const transformer = createRateLimiter();

    // Two consecutive editMessageText calls
    await transformer(prev as any, 'editMessageText' as any, {} as any);
    await transformer(prev as any, 'editMessageText' as any, {} as any);

    assert.equal(calls.length, 2);
    const gap = calls[1].timestamp - calls[0].timestamp;
    // With no per-method override, gap should be ~25ms (base interval), NOT 350ms
    // Allow 20ms jitter tolerance but cap at 100ms to prove no 350ms override
    assert.ok(gap < 100, `editMessageText gap should be < 100ms with default config (was ${gap}ms)`);
  });
});
