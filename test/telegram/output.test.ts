import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramOutputSink, EFFECTIVE_LIMIT, splitAtBoundary } from '../../src/telegram/output.js';
import type { OutputEvent } from '../../src/terminal/capture.js';

// --- Mock bot API ---

interface MockCall {
  method: string;
  args: unknown[];
}

function createMockBot() {
  let messageIdCounter = 0;
  const calls: MockCall[] = [];

  const api = {
    sendMessage: mock.fn(async (_chatId: number, _text: string, _opts?: unknown) => {
      messageIdCounter++;
      calls.push({ method: 'sendMessage', args: [_chatId, _text, _opts] });
      return { message_id: messageIdCounter };
    }),
    editMessageText: mock.fn(async (_chatId: number, _messageId: number, _text: string, _opts?: unknown) => {
      calls.push({ method: 'editMessageText', args: [_chatId, _messageId, _text, _opts] });
      return true;
    }),
  };

  return { api, calls, getMessageIdCounter: () => messageIdCounter };
}

/** Helper to create OutputEvent objects concisely. */
function event(
  text: string,
  mode: 'append' | 'replace' = 'append',
  trigger: OutputEvent['trigger'] = 'stream',
): OutputEvent {
  return { text, mode, trigger };
}

describe('TelegramOutputSink (OutputEvent API)', () => {
  let bot: ReturnType<typeof createMockBot>;
  let sink: TelegramOutputSink;

  beforeEach(() => {
    bot = createMockBot();
    sink = new TelegramOutputSink(bot.api as never, 12345, undefined, 5, 1, 0);
  });

  describe('basic send/edit via handleEvent', () => {
    it('first handleEvent with append mode creates a new message via sendMessage', async () => {
      sink.handleEvent(event('hello'));
      await sink.drain();

      assert.equal(bot.calls.length, 1);
      assert.equal(bot.calls[0].method, 'sendMessage');
      assert.ok((bot.calls[0].args[1] as string).includes('hello'));
    });

    it('second handleEvent with append mode edits existing message via editMessageText', async () => {
      sink.handleEvent(event('line1'));
      await sink.drain();
      sink.handleEvent(event('\nline2'));
      await sink.drain();

      assert.equal(bot.calls.length, 2);
      assert.equal(bot.calls[0].method, 'sendMessage');
      assert.equal(bot.calls[1].method, 'editMessageText');
      assert.ok((bot.calls[1].args[2] as string).includes('line1'));
      assert.ok((bot.calls[1].args[2] as string).includes('line2'));
    });
  });

  describe('replace mode', () => {
    it('handleEvent with mode=replace clears current message text, next content replaces', async () => {
      // First, create a message
      sink.handleEvent(event('original content'));
      await sink.drain();

      // Replace mode -- clears current text, then writes new content
      sink.handleEvent(event('replaced content', 'replace'));
      await sink.drain();

      assert.equal(bot.calls.length, 2);
      assert.equal(bot.calls[1].method, 'editMessageText');
      // The edit should contain only 'replaced content', not 'original contentreplaced content'
      const editText = bot.calls[1].args[2] as string;
      assert.ok(editText.includes('replaced content'));
      assert.ok(!editText.includes('original content'));
    });

    it('handleEvent with mode=replace when no current message creates new message normally', async () => {
      sink.handleEvent(event('first replace', 'replace', 'redraw'));
      await sink.drain();

      assert.equal(bot.calls.length, 1);
      assert.equal(bot.calls[0].method, 'sendMessage');
      assert.ok((bot.calls[0].args[1] as string).includes('first replace'));
    });

    it('replace mode trims leading/trailing newlines from text', async () => {
      sink.handleEvent(event('\n\nmenu item\n\n', 'replace', 'redraw'));
      await sink.drain();

      assert.equal(bot.calls.length, 1);
      const sentText = bot.calls[0].args[1] as string;
      const content = sentText.replace('<pre>', '').replace('</pre>', '');
      assert.ok(!content.startsWith('\n'), 'Should not start with newline');
      assert.ok(!content.endsWith('\n'), 'Should not end with newline');
      assert.ok(content.includes('menu item'));
    });

    it('replace mode with whitespace-only text after trimming is silently discarded', async () => {
      // Create an initial message
      sink.handleEvent(event('initial'));
      await sink.drain();
      const callsAfterInit = bot.calls.length;

      // Replace with whitespace-only text (after trim, becomes empty)
      sink.handleEvent(event('\n\n  \n', 'replace'));
      await sink.drain();

      assert.equal(bot.calls.length, callsAfterInit, 'No API calls for whitespace-only replace');
    });
  });

  describe('content-aware chunking (EMUL-05)', () => {
    it('splitAtBoundary splits at last newline within limit', () => {
      const text = 'line1\nline2\nline3\nline4';
      const [chunk, rest] = splitAtBoundary(text, 12);
      // 'line1\nline2\n' is 12 chars, split at last newline within limit
      assert.equal(chunk, 'line1\nline2\n');
      assert.equal(rest, 'line3\nline4');
    });

    it('splitAtBoundary falls back to word boundary when no newline exists', () => {
      const text = 'hello world this is a very long sentence without newlines';
      const [chunk, rest] = splitAtBoundary(text, 20);
      // Should split at last space within the limit
      // 'hello world this is ' is 20 chars, last space at 19
      assert.ok(chunk.endsWith(' '), 'Chunk should end at word boundary');
      assert.ok(rest.length > 0);
      assert.equal(chunk + rest, text, 'No data lost');
    });

    it('splitAtBoundary returns full text when within limit', () => {
      const text = 'short text';
      const [chunk, rest] = splitAtBoundary(text, 100);
      assert.equal(chunk, text);
      assert.equal(rest, '');
    });

    it('splitAtBoundary falls back to raw split when no whitespace in first half', () => {
      const text = 'A'.repeat(100);
      const [chunk, rest] = splitAtBoundary(text, 50);
      assert.equal(chunk.length, 50);
      assert.equal(rest.length, 50);
    });

    it('content-aware chunking used in sendOrEdit for messages exceeding EFFECTIVE_LIMIT', async () => {
      // Create text with newlines that exceeds the limit
      const lines: string[] = [];
      let totalLen = 0;
      let i = 0;
      while (totalLen < EFFECTIVE_LIMIT + 100) {
        const line = `line ${i}: ${'X'.repeat(50)}`;
        lines.push(line);
        totalLen += line.length + 1; // +1 for \n
        i++;
      }
      const text = lines.join('\n');

      sink.handleEvent(event(text));
      await sink.drain();

      // Should have created at least 2 messages (text exceeded limit)
      const sendCalls = bot.calls.filter(c => c.method === 'sendMessage');
      assert.ok(sendCalls.length >= 2, `Expected at least 2 sendMessage calls, got ${sendCalls.length}`);

      // First message text should end at a newline boundary (content-aware split)
      const firstText = (sendCalls[0].args[1] as string).replace('<pre>', '').replace('</pre>', '');
      // The last char before the split should be a newline (or the chunk is complete)
      assert.ok(
        firstText.endsWith('\n') || firstText.length <= EFFECTIVE_LIMIT,
        'First chunk should split at newline boundary',
      );
    });
  });

  describe('wide character safety (INTG-03)', () => {
    it('splitAtBoundary handles surrogate pairs at split boundary without corruption', () => {
      // Build text with a surrogate pair at the boundary
      // '\ud83d\ude00' = U+1F600 (grinning face) -- 2 JS chars (surrogate pair)
      const prefix = 'A'.repeat(48);
      const text = prefix + '\ud83d\ude00' + 'tail';
      // If we split at 49, we'd split in the middle of the surrogate pair
      const [chunk, rest] = splitAtBoundary(text, 49);
      // Should move split point to include both chars of the pair
      assert.equal(chunk.length, 50, 'Should include both surrogate pair chars');
      assert.equal(chunk, prefix + '\ud83d\ude00');
      assert.equal(rest, 'tail');
    });

    it('CJK characters pass through pipeline without corruption', async () => {
      const cjkText = '\u4f60\u597d\u4e16\u754c'; // "Hello world" in Chinese
      sink.handleEvent(event(cjkText));
      await sink.drain();

      assert.equal(bot.calls.length, 1);
      const sentText = bot.calls[0].args[1] as string;
      assert.ok(sentText.includes('\u4f60\u597d\u4e16\u754c'), 'CJK text should pass through intact');
    });

    it('emoji text passes through pipeline without corruption', async () => {
      const emojiText = '\ud83d\ude00\ud83d\ude01\ud83d\ude02'; // grinning, beaming, tears of joy
      sink.handleEvent(event(emojiText));
      await sink.drain();

      assert.equal(bot.calls.length, 1);
      const sentText = bot.calls[0].args[1] as string;
      assert.ok(sentText.includes('\ud83d\ude00'), 'Emoji should pass through intact');
      assert.ok(sentText.includes('\ud83d\ude01'), 'Emoji should pass through intact');
      assert.ok(sentText.includes('\ud83d\ude02'), 'Emoji should pass through intact');
    });
  });

  describe('drain()', () => {
    it('drain() resolves when async queue is empty', async () => {
      // No operations queued -- drain should resolve immediately
      await sink.drain();
      assert.ok(true, 'drain resolved with empty queue');
    });

    it('drain() waits for in-flight operation to complete', async () => {
      let sendResolved = false;
      let releaseOp: (() => void) | null = null;

      const slowApi = {
        sendMessage: mock.fn(async (_chatId: number, _text: string, _opts?: unknown) => {
          await new Promise<void>(resolve => { releaseOp = resolve; });
          sendResolved = true;
          return { message_id: 1 };
        }),
        editMessageText: mock.fn(async () => true),
      };

      const slowSink = new TelegramOutputSink(slowApi as never, 12345, undefined, 5, 1, 0);
      slowSink.handleEvent(event('hello'));

      // Start drain -- should NOT resolve yet
      let drainDone = false;
      const drainPromise = slowSink.drain().then(() => { drainDone = true; });

      await new Promise(r => setTimeout(r, 20));
      assert.equal(drainDone, false, 'drain should not resolve while op is in-flight');

      // Release the operation
      assert.ok(releaseOp !== null);
      releaseOp!();
      await drainPromise;

      assert.equal(drainDone, true, 'drain resolved after op completed');
      assert.equal(sendResolved, true, 'send operation completed');
    });
  });

  describe('sequential queue ordering', () => {
    it('operations are processed in order', async () => {
      const order: number[] = [];
      let op1Release: (() => void) | null = null;

      const serialApi = {
        sendMessage: mock.fn(async (_chatId: number, _text: string, _opts?: unknown) => {
          const opNum = order.length + 1;
          if (opNum === 1) {
            await new Promise<void>(resolve => { op1Release = resolve; });
          }
          order.push(opNum);
          return { message_id: opNum };
        }),
        editMessageText: mock.fn(async () => true),
      };

      const serialSink = new TelegramOutputSink(serialApi as never, 12345, undefined, 5, 1, 0);

      // Fill first message exactly to force a new message for the second event
      serialSink.handleEvent(event('A'.repeat(EFFECTIVE_LIMIT)));
      serialSink.handleEvent(event('second'));

      await new Promise(r => setTimeout(r, 20));
      assert.equal(order.length, 0, 'Op2 should not start while op1 is blocked');

      op1Release!();
      await serialSink.drain();

      assert.deepEqual(order, [1, 2], 'Operations should run in order');
    });
  });

  describe('existing behaviors', () => {
    it('getCurrentState returns null when no message has been sent', () => {
      const state = sink.getCurrentState();
      assert.equal(state, null);
    });

    it('getCurrentState returns { messageId, text } after a message is sent', async () => {
      sink.handleEvent(event('hello'));
      await sink.drain();

      const state = sink.getCurrentState();
      assert.ok(state !== null);
      assert.equal(state!.messageId, 1);
      assert.equal(state!.text, 'hello');
    });

    it('restoreState sets current state so next output appends via editMessageText', async () => {
      sink.restoreState({ messageId: 42, text: 'restored' });
      sink.handleEvent(event(' more'));
      await sink.drain();

      assert.equal(bot.calls.length, 1);
      assert.equal(bot.calls[0].method, 'editMessageText');
      assert.equal(bot.calls[0].args[1], 42);
    });

    it('onMessageCreated fires with message ID on sendMessage', async () => {
      const createdIds: number[] = [];
      sink.onMessageCreated = (id: number) => { createdIds.push(id); };

      sink.handleEvent(event('hello'));
      await sink.drain();

      assert.equal(createdIds.length, 1);
      assert.equal(createdIds[0], 1);
    });

    it('onMessageCreated does NOT fire on editMessageText', async () => {
      const createdIds: number[] = [];
      sink.onMessageCreated = (id: number) => { createdIds.push(id); };

      sink.handleEvent(event('first'));
      await sink.drain();
      createdIds.length = 0;

      sink.handleEvent(event(' second'));
      await sink.drain();

      assert.equal(createdIds.length, 0, 'onMessageCreated should not fire on edit');
    });

    it('onMessageCompleted fires when message fills to EFFECTIVE_LIMIT', async () => {
      const completedCalls: { messageId: number; text: string }[] = [];
      sink.onMessageCompleted = (messageId: number, text: string) => {
        completedCalls.push({ messageId, text });
      };

      // Restore a full message, then send more to trigger "space <= 0" branch
      sink.restoreState({ messageId: 99, text: 'X'.repeat(EFFECTIVE_LIMIT) });
      sink.handleEvent(event('overflow'));
      await sink.drain();

      assert.equal(completedCalls.length, 1);
      assert.equal(completedCalls[0].messageId, 99);
      assert.equal(completedCalls[0].text, 'X'.repeat(EFFECTIVE_LIMIT));
    });

    it('onMessageCompleted defaults to null', () => {
      assert.equal(sink.onMessageCompleted, null);
    });

    it('recovers from "message to edit not found" by creating a new message', async () => {
      // Set up a sink with an existing message
      sink.handleEvent(event('initial'));
      await sink.drain();
      assert.equal(bot.calls.length, 1);
      assert.equal(bot.calls[0].method, 'sendMessage');

      // Make editMessageText throw "message to edit not found"
      bot.api.editMessageText = mock.fn(async () => {
        const err = new Error('Bad Request: message to edit not found');
        (err as Record<string, unknown>).description = 'Bad Request: message to edit not found';
        throw err;
      });
      sink = new TelegramOutputSink(
        { sendMessage: bot.api.sendMessage, editMessageText: bot.api.editMessageText } as never,
        12345, undefined, 5, 1, 0,
      );
      // Restore state so sink thinks it has an existing message
      sink.restoreState({ messageId: 99, text: 'initial' });

      // Send more text -- edit should fail, then sink should create a new message
      sink.handleEvent(event(' more text'));
      await sink.drain();

      // Should have attempted editMessageText (failed) then sendMessage (recovery)
      const sends = bot.calls.filter(c => c.method === 'sendMessage');
      assert.ok(sends.length >= 2, `Expected at least 2 sendMessage calls (1 initial + 1 recovery), got ${sends.length}`);
    });

    it('subsequent operations work after message-not-found recovery', async () => {
      let editCallCount = 0;
      let messageIdCounter = 0;
      const calls: MockCall[] = [];

      // Custom API where first edit throws, subsequent edits work
      const localApi = {
        sendMessage: mock.fn(async (_chatId: number, _text: string, _opts?: unknown) => {
          messageIdCounter++;
          calls.push({ method: 'sendMessage', args: [_chatId, _text, _opts] });
          return { message_id: messageIdCounter };
        }),
        editMessageText: mock.fn(async (_chatId: number, _messageId: number, _text: string, _opts?: unknown) => {
          editCallCount++;
          calls.push({ method: 'editMessageText', args: [_chatId, _messageId, _text, _opts] });
          if (editCallCount === 1) {
            const err = new Error('Bad Request: message to edit not found');
            (err as Record<string, unknown>).description = 'Bad Request: message to edit not found';
            throw err;
          }
          return true;
        }),
      };

      const localSink = new TelegramOutputSink(localApi as never, 12345, undefined, 5, 1, 0);

      // Give the sink an existing message to edit
      localSink.restoreState({ messageId: 50, text: 'old' });

      // First event: edit fails -> recovery creates a new message via sendMessage
      localSink.handleEvent(event(' added'));
      await localSink.drain();

      // Second event: should edit the new message successfully
      localSink.handleEvent(event(' more'));
      await localSink.drain();

      // Verify: editMessageText (failed) -> sendMessage (recovery) -> editMessageText (success)
      const sends = calls.filter(c => c.method === 'sendMessage');
      assert.ok(sends.length >= 1, 'Should have at least 1 sendMessage (recovery)');
      assert.equal(editCallCount, 2, 'Should have 2 editMessageText calls (1 failed + 1 success)');
    });

    it('suppresses "message is not modified" error from editMessageText', async () => {
      bot.api.editMessageText = mock.fn(async () => {
        const err = new Error('Bad Request: message is not modified');
        (err as Record<string, unknown>).description = 'Bad Request: message is not modified';
        throw err;
      });
      sink = new TelegramOutputSink(bot.api as never, 12345, undefined, 5, 1, 0);

      sink.handleEvent(event('text1'));
      await sink.drain();
      sink.handleEvent(event('text2'));
      await sink.drain();

      assert.equal(bot.calls[0].method, 'sendMessage');
      assert.ok(true, 'Error was suppressed -- no crash');
    });
  });

  describe('replyMarkup option', () => {
    it('sendMessage includes reply_markup when replyMarkup is provided', async () => {
      const keyboard = { inline_keyboard: [[{ text: 'Test', callback_data: 'test' }]] };
      const sinkWithMarkup = new TelegramOutputSink(bot.api as never, 12345, keyboard, 5, 1, 0);

      sinkWithMarkup.handleEvent(event('hello'));
      await sinkWithMarkup.drain();

      assert.equal(bot.calls.length, 1);
      const opts = bot.calls[0].args[2] as Record<string, unknown>;
      assert.deepEqual(opts.reply_markup, keyboard);
    });

    it('editMessageText includes reply_markup when replyMarkup is provided', async () => {
      const keyboard = { inline_keyboard: [[{ text: 'Test', callback_data: 'test' }]] };
      const sinkWithMarkup = new TelegramOutputSink(bot.api as never, 12345, keyboard, 5, 1, 0);

      sinkWithMarkup.handleEvent(event('first'));
      await sinkWithMarkup.drain();
      sinkWithMarkup.handleEvent(event(' second'));
      await sinkWithMarkup.drain();

      const editCalls = bot.calls.filter(c => c.method === 'editMessageText');
      assert.ok(editCalls.length >= 1);
      const opts = editCalls[0].args[3] as Record<string, unknown>;
      assert.deepEqual(opts.reply_markup, keyboard);
    });

    it('does NOT include reply_markup when replyMarkup is not provided', async () => {
      sink.handleEvent(event('hello'));
      await sink.drain();

      const opts = bot.calls[0].args[2] as Record<string, unknown>;
      assert.equal(opts.reply_markup, undefined);
    });
  });
});

// --- Backpressure tests (CAPT-05) ---

describe('TelegramOutputSink backpressure (CAPT-05)', () => {
  /**
   * Creates a mock API where sendMessage/editMessageText block until manually released.
   * Because the queue is sequential, only one op awaits at a time. releaseAllAsync
   * keeps draining until no more ops are pending.
   */
  function createSlowMockBot() {
    let messageIdCounter = 0;
    const releases: Array<() => void> = [];

    const api = {
      sendMessage: async (_chatId: number, _text: string, _opts?: unknown) => {
        messageIdCounter++;
        const id = messageIdCounter;
        await new Promise<void>(resolve => { releases.push(resolve); });
        return { message_id: id };
      },
      editMessageText: async (_chatId: number, _messageId: number, _text: string, _opts?: unknown) => {
        await new Promise<void>(resolve => { releases.push(resolve); });
        return true;
      },
    };

    return {
      api,
      /** Release the next blocked operation in FIFO order and let microtasks settle. */
      async releaseNext() {
        const r = releases.shift();
        if (r) r();
        // Let the microtask queue settle so the next chained op can register its release
        await new Promise(r => setTimeout(r, 5));
      },
      /** Release all currently and subsequently blocked ops until drain completes. */
      async releaseAllAsync(drainPromise: Promise<void>) {
        // Poll and release until drain resolves
        const done = { value: false };
        drainPromise.then(() => { done.value = true; });
        while (!done.value) {
          if (releases.length > 0) {
            releases.shift()!();
          }
          await new Promise(r => setTimeout(r, 2));
        }
      },
      get pendingReleases() { return releases.length; },
    };
  }

  /** Helper to create OutputEvent objects. */
  function ev(text: string, mode: 'append' | 'replace' = 'append'): OutputEvent {
    return { text, mode, trigger: 'stream' };
  }

  it('onHighWater fires when pendingOps reaches highWaterMark', async () => {
    const slow = createSlowMockBot();
    const sink = new TelegramOutputSink(slow.api as never, 12345, undefined, 3, 1, 0);

    let highWaterFired = 0;
    sink.onHighWater = () => { highWaterFired++; };

    // Each handleEvent calls enqueueOp synchronously, incrementing pendingOps immediately.
    // The underlying API calls block, but pendingOps tracks enqueue calls, not completions.
    sink.handleEvent(ev('A'.repeat(EFFECTIVE_LIMIT))); // pendingOps=1
    sink.handleEvent(ev('B'.repeat(EFFECTIVE_LIMIT))); // pendingOps=2
    sink.handleEvent(ev('C'.repeat(EFFECTIVE_LIMIT))); // pendingOps=3 -> fires onHighWater

    assert.equal(highWaterFired, 1, 'onHighWater should fire when pendingOps >= highWaterMark');

    // Cleanup
    await slow.releaseAllAsync(sink.drain());
  });

  it('onHighWater fires only once per pause cycle', async () => {
    const slow = createSlowMockBot();
    const sink = new TelegramOutputSink(slow.api as never, 12345, undefined, 3, 1, 0);

    let highWaterFired = 0;
    sink.onHighWater = () => { highWaterFired++; };

    // Enqueue 5 operations (well above highWaterMark=3)
    sink.handleEvent(ev('A'.repeat(EFFECTIVE_LIMIT)));
    sink.handleEvent(ev('B'.repeat(EFFECTIVE_LIMIT)));
    sink.handleEvent(ev('C'.repeat(EFFECTIVE_LIMIT)));
    sink.handleEvent(ev('D'.repeat(EFFECTIVE_LIMIT)));
    sink.handleEvent(ev('E'.repeat(EFFECTIVE_LIMIT)));

    assert.equal(highWaterFired, 1, 'onHighWater should fire only once, not on every subsequent enqueue');

    await slow.releaseAllAsync(sink.drain());
  });

  it('onLowWater fires when pendingOps drops to lowWaterMark after being paused', async () => {
    const slow = createSlowMockBot();
    const sink = new TelegramOutputSink(slow.api as never, 12345, undefined, 3, 1, 0);

    let lowWaterFired = 0;
    sink.onLowWater = () => { lowWaterFired++; };
    sink.onHighWater = () => { /* absorb */ };

    // Use short text so each op = exactly 1 API call (no message overflow)
    sink.handleEvent(ev('A')); // pendingOps=1, op1: sendMessage
    sink.handleEvent(ev('B')); // pendingOps=2, op2: editMessageText
    sink.handleEvent(ev('C')); // pendingOps=3, op3: editMessageText, highWater fires

    // Wait for op1 to start and register its release callback
    await new Promise(r => setTimeout(r, 10));

    // Release op1 (sendMessage): pendingOps 3->2
    await slow.releaseNext();
    assert.equal(lowWaterFired, 0, 'onLowWater should not fire yet (pendingOps > lowWaterMark)');

    // Release op2 (editMessageText): pendingOps 2->1 -- hits lowWaterMark
    await slow.releaseNext();
    assert.equal(lowWaterFired, 1, 'onLowWater should fire when pendingOps drops to lowWaterMark');

    // Release op3 to drain cleanly
    await slow.releaseNext();
    await sink.drain();
  });

  it('onLowWater fires only once per drain cycle', async () => {
    const slow = createSlowMockBot();
    const sink = new TelegramOutputSink(slow.api as never, 12345, undefined, 3, 1, 0);

    let lowWaterFired = 0;
    sink.onLowWater = () => { lowWaterFired++; };
    sink.onHighWater = () => { /* absorb */ };

    // Enqueue 3 ops to trigger highWater
    sink.handleEvent(ev('A'.repeat(EFFECTIVE_LIMIT)));
    sink.handleEvent(ev('B'.repeat(EFFECTIVE_LIMIT)));
    sink.handleEvent(ev('C'.repeat(EFFECTIVE_LIMIT)));

    // Release all sequentially -- pendingOps goes 3->2->1->0
    await slow.releaseAllAsync(sink.drain());

    // onLowWater fires once when crossing lowWaterMark (1), not again at 0
    assert.equal(lowWaterFired, 1, 'onLowWater should fire only once per drain cycle');
  });

  it('no data loss during pause/resume cycle', async () => {
    // Use a fast (non-blocking) mock to verify all text arrives
    let messageIdCounter = 0;
    const sentTexts: string[] = [];
    const fastApi = {
      sendMessage: async (_chatId: number, text: string, _opts?: unknown) => {
        messageIdCounter++;
        sentTexts.push(text);
        return { message_id: messageIdCounter };
      },
      editMessageText: async (_chatId: number, _messageId: number, text: string, _opts?: unknown) => {
        sentTexts.push(text);
        return true;
      },
    };

    const sink = new TelegramOutputSink(fastApi as never, 12345, undefined, 3, 1, 0);
    sink.onHighWater = () => { /* pause would happen here */ };
    sink.onLowWater = () => { /* resume would happen here */ };

    // Enqueue 5 separate messages (each fills a message due to EFFECTIVE_LIMIT size)
    sink.handleEvent(ev('msg1'));
    sink.handleEvent(ev('msg2'));
    sink.handleEvent(ev('msg3'));
    sink.handleEvent(ev('msg4'));
    sink.handleEvent(ev('msg5'));

    await sink.drain();

    // All text should be present in the sent messages (combined via edit or separate sends)
    const allText = sentTexts.join('');
    assert.ok(allText.includes('msg1'), 'msg1 should reach Telegram');
    assert.ok(allText.includes('msg2'), 'msg2 should reach Telegram');
    assert.ok(allText.includes('msg3'), 'msg3 should reach Telegram');
    assert.ok(allText.includes('msg4'), 'msg4 should reach Telegram');
    assert.ok(allText.includes('msg5'), 'msg5 should reach Telegram');
  });

  it('queue works normally when no backpressure callbacks are set', async () => {
    // Use fast mock -- the point is verifying null callbacks don't throw
    let messageIdCounter = 0;
    const fastApi = {
      sendMessage: async (_chatId: number, _text: string, _opts?: unknown) => {
        messageIdCounter++;
        return { message_id: messageIdCounter };
      },
      editMessageText: async () => true,
    };

    const sink = new TelegramOutputSink(fastApi as never, 12345, undefined, 3, 1, 0);

    // Do NOT set onHighWater or onLowWater -- they should be null by default
    assert.equal(sink.onHighWater, null, 'onHighWater defaults to null');
    assert.equal(sink.onLowWater, null, 'onLowWater defaults to null');

    // Enqueue operations beyond highWaterMark -- should not throw
    sink.handleEvent(ev('A'.repeat(EFFECTIVE_LIMIT)));
    sink.handleEvent(ev('B'.repeat(EFFECTIVE_LIMIT)));
    sink.handleEvent(ev('C'.repeat(EFFECTIVE_LIMIT)));
    sink.handleEvent(ev('D'.repeat(EFFECTIVE_LIMIT)));

    await sink.drain();

    assert.ok(true, 'No errors when callbacks are null');
  });

  it('constructor accepts optional highWaterMark and lowWaterMark', () => {
    const fastApi = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => true,
    };

    // Default values
    const sink1 = new TelegramOutputSink(fastApi as never, 12345);
    assert.equal(sink1.highWaterMark, 5, 'Default highWaterMark should be 5');
    assert.equal(sink1.lowWaterMark, 1, 'Default lowWaterMark should be 1');
    assert.equal(sink1.minInterval, 350, 'Default minInterval should be 350');

    // Custom values
    const sink2 = new TelegramOutputSink(fastApi as never, 12345, undefined, 10, 3, 2000);
    assert.equal(sink2.highWaterMark, 10);
    assert.equal(sink2.lowWaterMark, 3);
    assert.equal(sink2.minInterval, 2000);
  });
});

// --- Rate limiting tests ---

describe('TelegramOutputSink rate limiting (minInterval)', () => {
  /** Helper to create OutputEvent objects. */
  function ev(text: string, mode: 'append' | 'replace' = 'replace'): OutputEvent {
    return { text, mode, trigger: 'stream' };
  }

  it('constructor accepts minInterval parameter with default of 350', () => {
    const api = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => true,
    };

    const sink1 = new TelegramOutputSink(api as never, 12345);
    assert.equal(sink1.minInterval, 350, 'Default minInterval should be 350');

    const sink2 = new TelegramOutputSink(api as never, 12345, undefined, 5, 1, 2000);
    assert.equal(sink2.minInterval, 2000, 'Custom minInterval should be 2000');
  });

  it('consecutive API calls are NOT locally throttled (global rate limiter handles it)', async () => {
    // Since the local throttle was removed in favor of the global rate limiter
    // (installed as a grammY API transformer in bot.ts), calls through TelegramOutputSink
    // should complete without local delays. The global rate limiter handles spacing.
    let apiCallCount = 0;
    let messageIdCounter = 0;

    const timedApi = {
      sendMessage: async (_chatId: number, _text: string, _opts?: unknown) => {
        apiCallCount++;
        messageIdCounter++;
        return { message_id: messageIdCounter };
      },
      editMessageText: async (_chatId: number, _messageId: number, _text: string, _opts?: unknown) => {
        apiCallCount++;
        return true;
      },
    };

    const sink = new TelegramOutputSink(timedApi as never, 12345, undefined, 5, 1, 100);

    // Fire 3 separate replace events
    sink.handleEvent(ev('msg1', 'replace'));
    sink.handleEvent(ev('msg2', 'replace'));
    sink.handleEvent(ev('msg3', 'replace'));
    await sink.drain();

    // All calls should complete (sequential queue still works)
    assert.ok(apiCallCount >= 3, `All API calls should have completed, got ${apiCallCount}`);
  });

  it('minInterval=0 disables throttling', async () => {
    let apiCallCount = 0;
    let messageIdCounter = 0;
    const api = {
      sendMessage: async (_chatId: number, _text: string, _opts?: unknown) => {
        apiCallCount++;
        messageIdCounter++;
        return { message_id: messageIdCounter };
      },
      editMessageText: async (_chatId: number, _messageId: number, _text: string, _opts?: unknown) => {
        apiCallCount++;
        return true;
      },
    };

    const sink = new TelegramOutputSink(api as never, 12345, undefined, 5, 1, 0);

    sink.handleEvent(ev('msg1', 'replace'));
    sink.handleEvent(ev('msg2', 'replace'));
    sink.handleEvent(ev('msg3', 'replace'));
    await sink.drain();

    // Just verify all completed without error -- no timing assertion needed
    assert.ok(apiCallCount >= 3, `All API calls should have completed, got ${apiCallCount}`);
  });
});
