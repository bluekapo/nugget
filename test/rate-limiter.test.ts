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
  it('Test 1: Sequential interactive calls are spaced at interactiveInterval', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = { interactiveInterval: 80, outputInterval: 2000 };
    const transformer = createRateLimiter(config);

    // Fire 3 sequential sendMessage calls (interactive channel)
    await transformer(prev as any, 'sendMessage' as any, {} as any);
    await transformer(prev as any, 'sendMessage' as any, {} as any);
    await transformer(prev as any, 'sendMessage' as any, {} as any);

    assert.equal(calls.length, 3);
    // Each gap should be >= interactiveInterval (allow 30ms jitter tolerance)
    const gap1 = calls[1].timestamp - calls[0].timestamp;
    const gap2 = calls[2].timestamp - calls[1].timestamp;
    assert.ok(gap1 >= 80 - 30, `Gap 1 should be >= 50ms (was ${gap1}ms)`);
    assert.ok(gap2 >= 80 - 30, `Gap 2 should be >= 50ms (was ${gap2}ms)`);
  });

  it('Test 2: editMessageText calls use outputInterval spacing', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = {
      interactiveInterval: 50,
      outputInterval: 200,
    };
    const transformer = createRateLimiter(config);

    // Two consecutive editMessageText calls with different message IDs (no coalescing)
    await transformer(prev as any, 'editMessageText' as any, { chat_id: 1, message_id: 1 } as any);
    await transformer(prev as any, 'editMessageText' as any, { chat_id: 1, message_id: 2 } as any);

    assert.equal(calls.length, 2);
    const gap = calls[1].timestamp - calls[0].timestamp;
    // Should be at least outputInterval (200ms), allow 30ms jitter
    assert.ok(gap >= 200 - 30, `editMessageText gap should be >= 170ms (was ${gap}ms)`);
  });

  it('Test 3: Multiple concurrent interactive calls are queued and executed in order', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = { interactiveInterval: 30, outputInterval: 2000 };
    const transformer = createRateLimiter(config);

    // Fire 5 sendMessage calls concurrently -- they should queue up, not drop
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
    const transformer = createRateLimiter({ interactiveInterval: 0, outputInterval: 0 });

    const result = await transformer(prev as any, 'sendMessage' as any, {} as any);
    assert.deepStrictEqual(result, { ok: true, result: { message_id: 42 } });
  });

  it('Test 5: If underlying call fails, error propagates to caller', async () => {
    const prev = async (_method: string, _payload: unknown, _signal?: AbortSignal) => {
      throw new Error('Telegram API down');
    };
    const transformer = createRateLimiter({ interactiveInterval: 0, outputInterval: 0 });

    await assert.rejects(
      () => transformer(prev as any, 'sendMessage' as any, {} as any),
      { message: 'Telegram API down' },
    );
  });

  it('Test 6: 3 editMessageText calls for same (chat_id, message_id) produce only 1 API call', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = { interactiveInterval: 50, outputInterval: 200 };
    const transformer = createRateLimiter(config);

    // Fire 3 edits to the same message concurrently
    const p1 = transformer(prev as any, 'editMessageText' as any, { chat_id: 100, message_id: 5, text: 'first' } as any);
    const p2 = transformer(prev as any, 'editMessageText' as any, { chat_id: 100, message_id: 5, text: 'second' } as any);
    const p3 = transformer(prev as any, 'editMessageText' as any, { chat_id: 100, message_id: 5, text: 'third' } as any);

    await Promise.all([p1, p2, p3]);

    // Only 1 API call should have been made (the last payload)
    assert.equal(calls.length, 1, `Expected 1 API call, got ${calls.length}`);
    assert.deepStrictEqual((calls[0].payload as any).text, 'third');
  });

  it('Test 7: Coalesced callers all receive the same resolved value', async () => {
    const { prev } = createMockPrev();
    const config: RateLimiterConfig = { interactiveInterval: 50, outputInterval: 200 };
    const transformer = createRateLimiter(config);

    const p1 = transformer(prev as any, 'editMessageText' as any, { chat_id: 100, message_id: 5, text: 'a' } as any);
    const p2 = transformer(prev as any, 'editMessageText' as any, { chat_id: 100, message_id: 5, text: 'b' } as any);
    const p3 = transformer(prev as any, 'editMessageText' as any, { chat_id: 100, message_id: 5, text: 'c' } as any);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // All three should get the same result
    assert.deepStrictEqual(r1, r2);
    assert.deepStrictEqual(r2, r3);
  });

  it('Test 8: sendMessage is not blocked behind queued editMessageText calls', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = { interactiveInterval: 50, outputInterval: 500 };
    const transformer = createRateLimiter(config);

    // Queue up 3 edits to different messages (no coalescing, so 3 output queue slots)
    const editPromises = [
      transformer(prev as any, 'editMessageText' as any, { chat_id: 1, message_id: 1, text: 'e1' } as any),
      transformer(prev as any, 'editMessageText' as any, { chat_id: 1, message_id: 2, text: 'e2' } as any),
      transformer(prev as any, 'editMessageText' as any, { chat_id: 1, message_id: 3, text: 'e3' } as any),
    ];

    // Immediately send a sendMessage (interactive channel)
    const sendStart = Date.now();
    const sendPromise = transformer(prev as any, 'sendMessage' as any, { chat_id: 1, text: 'hello' } as any);
    await sendPromise;
    const sendDuration = Date.now() - sendStart;

    // sendMessage should complete quickly (~50ms interactive spacing), not wait for all edits
    // If it were blocked behind 3 edits at 500ms each, it would take 1500ms+
    assert.ok(sendDuration < 300, `sendMessage took ${sendDuration}ms, expected < 300ms (should not be blocked by output queue)`);

    await Promise.all(editPromises);
  });

  it('Test 9: answerCallbackQuery goes through the interactive channel (fast path)', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = { interactiveInterval: 50, outputInterval: 500 };
    const transformer = createRateLimiter(config);

    // Queue an edit first
    const editPromise = transformer(prev as any, 'editMessageText' as any, { chat_id: 1, message_id: 1, text: 'e1' } as any);

    // Then answerCallbackQuery (should go through interactive, not output)
    const cbStart = Date.now();
    const cbPromise = transformer(prev as any, 'answerCallbackQuery' as any, { callback_query_id: '123' } as any);
    await cbPromise;
    const cbDuration = Date.now() - cbStart;

    // answerCallbackQuery should not wait for edit's 500ms output spacing
    assert.ok(cbDuration < 300, `answerCallbackQuery took ${cbDuration}ms, expected < 300ms`);

    await editPromise;
  });

  it('Test 10: Output edits respect outputInterval spacing between each other', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = { interactiveInterval: 50, outputInterval: 150 };
    const transformer = createRateLimiter(config);

    // 3 edits to different messages (no coalescing)
    await transformer(prev as any, 'editMessageText' as any, { chat_id: 1, message_id: 1, text: 'a' } as any);
    await transformer(prev as any, 'editMessageText' as any, { chat_id: 1, message_id: 2, text: 'b' } as any);
    await transformer(prev as any, 'editMessageText' as any, { chat_id: 1, message_id: 3, text: 'c' } as any);

    assert.equal(calls.length, 3);
    const gap1 = calls[1].timestamp - calls[0].timestamp;
    const gap2 = calls[2].timestamp - calls[1].timestamp;
    assert.ok(gap1 >= 150 - 30, `Gap 1 should be >= 120ms (was ${gap1}ms)`);
    assert.ok(gap2 >= 150 - 30, `Gap 2 should be >= 120ms (was ${gap2}ms)`);
  });

  it('Test 11: Sequential ordering within each channel is preserved', async () => {
    const { prev, calls } = createMockPrev();
    const config: RateLimiterConfig = { interactiveInterval: 10, outputInterval: 10 };
    const transformer = createRateLimiter(config);

    // Fire interleaved calls
    const promises = [
      transformer(prev as any, 'sendMessage' as any, { type: 'interactive', id: 1 } as any),
      transformer(prev as any, 'editMessageText' as any, { type: 'output', id: 1, chat_id: 1, message_id: 1 } as any),
      transformer(prev as any, 'sendMessage' as any, { type: 'interactive', id: 2 } as any),
      transformer(prev as any, 'editMessageText' as any, { type: 'output', id: 2, chat_id: 1, message_id: 2 } as any),
    ];

    await Promise.all(promises);

    // Interactive calls should be in order relative to each other
    const interactiveCalls = calls.filter(c => c.method === 'sendMessage');
    assert.equal(interactiveCalls.length, 2);
    assert.deepStrictEqual((interactiveCalls[0].payload as any).id, 1);
    assert.deepStrictEqual((interactiveCalls[1].payload as any).id, 2);

    // Output calls should be in order relative to each other
    const outputCalls = calls.filter(c => c.method === 'editMessageText');
    assert.equal(outputCalls.length, 2);
    assert.deepStrictEqual((outputCalls[0].payload as any).id, 1);
    assert.deepStrictEqual((outputCalls[1].payload as any).id, 2);
  });
});
