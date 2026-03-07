import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramInputHandler } from '../../src/telegram/input.js';

describe('TelegramInputHandler', () => {
  // --- Helpers ---

  function makeMockSessionManager() {
    const calls: Array<{ name: string; data: string }> = [];
    return {
      writeToSession(name: string, data: string): void {
        calls.push({ name, data });
      },
      calls,
    };
  }

  function makeMockAllowlist(allowed: boolean) {
    return {
      isAllowed(_input: string): boolean {
        return allowed;
      },
      describe(): string {
        return '/clear, /compact';
      },
    };
  }

  function makeMockCtx(text?: string) {
    const replies: string[] = [];
    let deleteMessageCalled = false;
    let deleteMessageThrows = false;
    return {
      message: text !== undefined ? { text } : undefined,
      async reply(msg: string) {
        replies.push(msg);
      },
      async deleteMessage() {
        if (deleteMessageThrows) throw new Error('Bot lacks permission');
        deleteMessageCalled = true;
      },
      replies,
      get deleteMessageCalled() { return deleteMessageCalled; },
      set deleteMessageThrows(v: boolean) { deleteMessageThrows = v; },
    };
  }

  it('forwards allowed text message to PTY via writeToSession(name, text)', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('hello world');
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 1);
    assert.equal(sm.calls[0].name, 'my-session');
    assert.equal(sm.calls[0].data, 'hello world');
    assert.equal(nextCalled, false);
  });

  it('rejects disallowed text with ctx.reply() containing allowlist description', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(false);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('rm -rf /');
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 0, 'should not write to session');
    assert.equal(ctx.replies.length, 1);
    assert.ok(ctx.replies[0].includes('/clear'), 'reply should contain allowlist description');
    assert.equal(nextCalled, false);
  });

  it('skips messages with no text (calls next())', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx(); // no text
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 0);
    assert.equal(nextCalled, true);
  });

  it('uses correct session name from getActiveSession()', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'custom-session', al as any);

    const ctx = makeMockCtx('test');
    await handler.handler()(ctx as any, async () => {});

    assert.equal(sm.calls[0].name, 'custom-session');
  });

  it('replies "No active session..." when getActiveSession() returns null', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => null, al as any);

    const ctx = makeMockCtx('hello');
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 0, 'should not write to session');
    assert.equal(ctx.replies.length, 1);
    assert.ok(ctx.replies[0].includes('No active session'), 'should reply about no active session');
    assert.equal(nextCalled, false);
  });

  it('skips known bot commands (/hub) and calls next()', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('/hub');
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 0, 'should not forward command to session');
    assert.equal(ctx.replies.length, 0, 'should not reply');
    assert.equal(nextCalled, true, 'should call next() to let command handlers process it');
  });

  it('skips /start and calls next() (bot command)', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('/start');
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 0, 'should not forward to session');
    assert.equal(nextCalled, true, 'should call next() for bot command');
  });

  it('skips /help and calls next() (bot command)', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('/help');
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 0, 'should not forward to session');
    assert.equal(nextCalled, true, 'should call next() for bot command');
  });

  it('forwards /gsd:plan-phase to PTY (not a bot command)', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('/gsd:plan-phase 2');
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 1, 'should forward to session');
    assert.equal(sm.calls[0].data, '/gsd:plan-phase 2');
    assert.equal(nextCalled, false, 'should NOT call next()');
  });

  it('forwards /clear to PTY (not a registered bot command)', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('/clear');
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 1, 'should forward to session');
    assert.equal(sm.calls[0].data, '/clear');
    assert.equal(nextCalled, false, 'should NOT call next()');
  });

  it('forwards /unknowncommand to PTY (not a bot command)', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('/unknowncommand');
    let nextCalled = false;
    await handler.handler()(ctx as any, async () => { nextCalled = true; });

    assert.equal(sm.calls.length, 1, 'should forward to session');
    assert.equal(sm.calls[0].data, '/unknowncommand');
    assert.equal(nextCalled, false, 'should NOT call next()');
  });

  it('auto-deletes user message after forwarding text to PTY', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('hello world');
    await handler.handler()(ctx as any, async () => {});

    assert.equal(sm.calls.length, 1, 'should forward to session');
    assert.equal(ctx.deleteMessageCalled, true, 'should delete user message');
  });

  it('auto-deletes user message when blocked by allowlist', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(false);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('rm -rf /');
    await handler.handler()(ctx as any, async () => {});

    assert.equal(sm.calls.length, 0, 'should not write to session');
    assert.equal(ctx.replies.length, 1, 'should reply with allowlist error');
    assert.equal(ctx.deleteMessageCalled, true, 'should delete user message');
  });

  it('does not throw when deleteMessage fails (silently catches error)', async () => {
    const sm = makeMockSessionManager();
    const al = makeMockAllowlist(true);
    const handler = new TelegramInputHandler(sm as any, () => 'my-session', al as any);

    const ctx = makeMockCtx('hello');
    ctx.deleteMessageThrows = true;

    // Should not throw
    await handler.handler()(ctx as any, async () => {});

    assert.equal(sm.calls.length, 1, 'should still forward to session');
    assert.equal(ctx.deleteMessageCalled, false, 'deleteMessage threw, so flag stays false');
  });
});
