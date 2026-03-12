import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeAnswer } from '../src/telegram/keyboard.js';

describe('safeAnswer', () => {
  it('does not throw when answerCallbackQuery rejects with "query is too old"', async () => {
    const ctx = {
      answerCallbackQuery: async () => {
        throw new Error('Bad Request: query is too old and response timeout expired or query ID is invalid and target chat is not known');
      },
    };

    // Should not throw
    await assert.doesNotReject(() => safeAnswer(ctx));
  });

  it('does not throw when answerCallbackQuery rejects with "query ID is invalid"', async () => {
    const ctx = {
      answerCallbackQuery: async () => {
        throw new Error('Bad Request: query ID is invalid');
      },
    };

    // Should not throw
    await assert.doesNotReject(() => safeAnswer(ctx));
  });

  it('calls answerCallbackQuery with correct options when it succeeds', async () => {
    let receivedOpts: { text?: string } | undefined;
    const ctx = {
      answerCallbackQuery: async (opts?: { text?: string }) => {
        receivedOpts = opts;
      },
    };

    await safeAnswer(ctx, { text: 'Hello' });
    assert.deepStrictEqual(receivedOpts, { text: 'Hello' });
  });

  it('calls answerCallbackQuery with no options when none provided', async () => {
    let called = false;
    let receivedOpts: unknown;
    const ctx = {
      answerCallbackQuery: async (opts?: { text?: string }) => {
        called = true;
        receivedOpts = opts;
      },
    };

    await safeAnswer(ctx);
    assert.ok(called, 'answerCallbackQuery should have been called');
    assert.strictEqual(receivedOpts, undefined);
  });
});
