import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_BUTTONS, buildCLIKeyboard, buildControlsKeyboard, registerCallbackHandlers } from '../../src/telegram/keyboard.js';
import { InlineKeyboard } from 'grammy';

describe('InlineKeyboard', () => {
  describe('ACTION_BUTTONS', () => {
    it('has scrollUp, scrollDown, clear, backspace keys', () => {
      assert.ok('scrollUp' in ACTION_BUTTONS);
      assert.ok('scrollDown' in ACTION_BUTTONS);
      assert.ok('clear' in ACTION_BUTTONS);
      assert.ok('backspace' in ACTION_BUTTONS);
    });

    it('has arrowUp, arrowDown, enter keys', () => {
      assert.ok('arrowUp' in ACTION_BUTTONS);
      assert.ok('arrowDown' in ACTION_BUTTONS);
      assert.ok('enter' in ACTION_BUTTONS);
    });

    it('arrowUp.input is ESC[A', () => {
      assert.equal(ACTION_BUTTONS.arrowUp.input, '\x1b[A');
    });

    it('arrowDown.input is ESC[B', () => {
      assert.equal(ACTION_BUTTONS.arrowDown.input, '\x1b[B');
    });

    it('enter.input is carriage return', () => {
      assert.equal(ACTION_BUTTONS.enter.input, '\r');
    });

    it('each entry has label, data, and input properties', () => {
      for (const [_key, btn] of Object.entries(ACTION_BUTTONS)) {
        assert.ok(typeof btn.label === 'string', 'label should be string');
        assert.ok(typeof btn.data === 'string', 'data should be string');
        assert.ok(typeof btn.input === 'string', 'input should be string');
      }
    });

    it('scrollUp input is Page Up escape sequence', () => {
      assert.equal(ACTION_BUTTONS.scrollUp.input, '\x1b[5~');
    });

    it('scrollDown input is Page Down escape sequence', () => {
      assert.equal(ACTION_BUTTONS.scrollDown.input, '\x1b[6~');
    });

    it('clear input is "/clear"', () => {
      assert.equal(ACTION_BUTTONS.clear.input, '/clear');
    });

    it('backspace input is DEL char', () => {
      assert.equal(ACTION_BUTTONS.backspace.input, '\x7f');
    });
  });

  describe('buildControlsKeyboard()', () => {
    it('returns an InlineKeyboard instance', () => {
      const kb = buildControlsKeyboard();
      assert.ok(kb instanceof InlineKeyboard);
    });

    it('includes delete button as last row', () => {
      const kb = buildControlsKeyboard();
      const rows = kb.inline_keyboard;
      assert.ok(rows.length > 0, 'keyboard should have rows');
      const lastRow = rows[rows.length - 1];
      assert.equal(lastRow.length, 1, 'last row should have exactly one button');
      assert.equal(lastRow[0].callback_data, 'action:delete', 'last button should be action:delete');
    });
  });

  describe('buildCLIKeyboard()', () => {
    it('scroll row has 3 buttons: Up, Lock, Down', () => {
      const kb = buildCLIKeyboard();
      const scrollRow = kb.inline_keyboard[0];
      assert.equal(scrollRow.length, 3, 'scroll row should have 3 buttons');
      assert.equal(scrollRow[0].callback_data, 'action:scroll-up');
      assert.equal(scrollRow[1].callback_data, 'action:scroll-lock');
      assert.equal(scrollRow[2].callback_data, 'action:scroll-down');
    });

    it('lock button shows red circle + locked emoji when locked=true', () => {
      const kb = buildCLIKeyboard(true);
      const lockBtn = kb.inline_keyboard[0][1];
      assert.equal(lockBtn.text, '\uD83D\uDD34\uD83D\uDD12', 'lock button should show red circle + locked emoji');
    });

    it('lock button shows green circle + unlocked emoji when locked=false', () => {
      const kb = buildCLIKeyboard(false);
      const lockBtn = kb.inline_keyboard[0][1];
      assert.equal(lockBtn.text, '\uD83D\uDFE2\uD83D\uDD13', 'lock button should show green circle + unlocked emoji');
    });

    it('scroll buttons show lock prefix when locked=true', () => {
      const kb = buildCLIKeyboard(true);
      const scrollUp = kb.inline_keyboard[0][0];
      const scrollDown = kb.inline_keyboard[0][2];
      assert.ok(scrollUp.text.includes('\uD83D\uDD12'), 'scroll up should include lock emoji when locked');
      assert.ok(scrollDown.text.includes('\uD83D\uDD12'), 'scroll down should include lock emoji when locked');
    });

    it('scroll buttons have no lock prefix when locked=false', () => {
      const kb = buildCLIKeyboard(false);
      const scrollUp = kb.inline_keyboard[0][0];
      const scrollDown = kb.inline_keyboard[0][2];
      assert.ok(!scrollUp.text.includes('\uD83D\uDD12'), 'scroll up should not include lock emoji when unlocked');
      assert.ok(!scrollDown.text.includes('\uD83D\uDD12'), 'scroll down should not include lock emoji when unlocked');
    });
  });

  describe('buildControlsKeyboard() scroll row', () => {
    it('scroll row has 3 buttons: Up, Lock, Down', () => {
      const kb = buildControlsKeyboard();
      const scrollRow = kb.inline_keyboard[0];
      assert.equal(scrollRow.length, 3, 'scroll row should have 3 buttons');
      assert.equal(scrollRow[0].callback_data, 'action:scroll-up');
      assert.equal(scrollRow[1].callback_data, 'action:scroll-lock');
      assert.equal(scrollRow[2].callback_data, 'action:scroll-down');
    });

    it('lock button reflects locked state with colored circle', () => {
      const kbLocked = buildControlsKeyboard(true);
      assert.equal(kbLocked.inline_keyboard[0][1].text, '\uD83D\uDD34\uD83D\uDD12');

      const kbUnlocked = buildControlsKeyboard(false);
      assert.equal(kbUnlocked.inline_keyboard[0][1].text, '\uD83D\uDFE2\uD83D\uDD13');
    });
  });

  describe('registerCallbackHandlers', () => {
    it('registers a handler for each ACTION_BUTTONS entry plus hub handlers and catch-all', () => {
      const registeredQueries: Array<string | RegExp> = [];
      const registeredOn: string[] = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, _handler: unknown) {
          registeredQueries.push(data);
        },
        on(filter: string, _handler: unknown) {
          registeredOn.push(filter);
        },
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test-session',
        mockRouter as any,
      );

      const expectedActionQueries = Object.values(ACTION_BUTTONS).map((b) => b.data);
      for (const q of expectedActionQueries) {
        assert.ok(
          registeredQueries.some(rq => rq === q),
          `should register handler for ${q}`,
        );
      }
    });

    it('registers hub:switch and hub:disconnect regex handlers', () => {
      const registeredQueries: Array<string | RegExp> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, _handler: unknown) {
          registeredQueries.push(data);
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test-session',
        mockRouter as any,
      );

      const regexQueries = registeredQueries.filter(q => q instanceof RegExp);
      assert.ok(
        regexQueries.some(r => r.test('hub:switch:my-session')),
        'should register hub:switch regex handler',
      );
      assert.ok(
        regexQueries.some(r => r.test('hub:disconnect:my-session')),
        'should register hub:disconnect regex handler',
      );
    });

    it('action button handler writes to dynamically resolved session', async () => {
      const writeCalls: Array<{ name: string; data: string }> = [];
      let currentSession: string | null = 'dynamic-session';

      const handlers: Map<string, (ctx: any) => Promise<void>> = new Map();
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (typeof data === 'string') {
            handlers.set(data, handler);
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(name: string, data: string) {
          writeCalls.push({ name, data });
        },
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => currentSession,
        mockRouter as any,
      );

      const mockCtx = {
        async answerCallbackQuery(_opts?: unknown) {},
      };

      // Call scrollUp handler
      const scrollUpHandler = handlers.get(ACTION_BUTTONS.scrollUp.data);
      assert.ok(scrollUpHandler, 'scrollUp handler should be registered');
      await scrollUpHandler(mockCtx);

      assert.equal(writeCalls.length, 1);
      assert.equal(writeCalls[0].name, 'dynamic-session');
    });

    it('action button handler calls answerCallbackQuery with no arguments (no hint text)', async () => {
      const handlers: Map<string, (ctx: any) => Promise<void>> = new Map();
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (typeof data === 'string') {
            handlers.set(data, handler);
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test-session',
        mockRouter as any,
      );

      const answerArgs: unknown[] = [];
      const mockCtx = {
        async answerCallbackQuery(...args: unknown[]) {
          answerArgs.push(...args);
        },
      };

      const scrollUpHandler = handlers.get(ACTION_BUTTONS.scrollUp.data);
      assert.ok(scrollUpHandler, 'scrollUp handler should be registered');
      await scrollUpHandler(mockCtx);

      assert.equal(answerArgs.length, 0, 'answerCallbackQuery should be called with no arguments (no hint text)');
    });

    it('action button handler replies "No active session" when getActiveSession returns null', async () => {
      const handlers: Map<string, (ctx: any) => Promise<void>> = new Map();
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (typeof data === 'string') {
            handlers.set(data, handler);
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => null,
        mockRouter as any,
      );

      let answerText = '';
      const mockCtx = {
        async answerCallbackQuery(opts?: { text?: string }) {
          answerText = opts?.text ?? '';
        },
      };

      const scrollUpHandler = handlers.get(ACTION_BUTTONS.scrollUp.data);
      assert.ok(scrollUpHandler);
      await scrollUpHandler(mockCtx);

      assert.ok(answerText.includes('No active session'), 'should answer with no active session message');
    });

    it('hub:switch handler calls router.switchTo and answers callback', async () => {
      const regexHandlers: Array<{ pattern: RegExp; handler: (ctx: any) => Promise<void> }> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (data instanceof RegExp) {
            regexHandlers.push({ pattern: data, handler });
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      let switchedTo = '';
      const mockRouter = {
        switchTo(name: string) { switchedTo = name; },
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'old-session',
        mockRouter as any,
      );

      const switchHandler = regexHandlers.find(h => h.pattern.test('hub:switch:project-a'));
      assert.ok(switchHandler, 'hub:switch handler should be registered');

      let answerText = '';
      const mockCtx = {
        match: 'hub:switch:project-a'.match(/^hub:switch:(.+)$/),
        async answerCallbackQuery(opts?: { text?: string }) {
          answerText = opts?.text ?? '';
        },
      };

      await switchHandler.handler(mockCtx);

      assert.equal(switchedTo, 'project-a');
      assert.ok(answerText.includes('project-a'), 'answer should mention the session name');
    });

    it('hub:disconnect handler calls sessionManager.stop + router.remove for local sessions', async () => {
      const regexHandlers: Array<{ pattern: RegExp; handler: (ctx: any) => Promise<void> }> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (data instanceof RegExp) {
            regexHandlers.push({ pattern: data, handler });
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      let stoppedName = '';
      let removedName = '';
      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(name: string) { stoppedName = name; },
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(name: string) { removedName = name; },
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return ['other']; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'current',
        mockRouter as any,
      );

      const disconnectHandler = regexHandlers.find(h => h.pattern.test('hub:disconnect:project-b'));
      assert.ok(disconnectHandler, 'hub:disconnect handler should be registered');

      let answerText = '';
      const mockCtx = {
        match: 'hub:disconnect:project-b'.match(/^hub:disconnect:(.+)$/),
        async answerCallbackQuery(opts?: { text?: string }) {
          answerText = opts?.text ?? '';
        },
      };

      await disconnectHandler.handler(mockCtx);

      assert.equal(stoppedName, 'project-b');
      assert.equal(removedName, 'project-b');
      assert.ok(answerText.includes('project-b'), 'answer should mention the session name');
    });

    it('hub:disconnect handler uses removeRemote for remote sessions', async () => {
      const regexHandlers: Array<{ pattern: RegExp; handler: (ctx: any) => Promise<void> }> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (data instanceof RegExp) {
            regexHandlers.push({ pattern: data, handler });
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      let stoppedName = '';
      let removedName = '';
      let removedRemoteName = '';
      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(name: string) { stoppedName = name; },
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(name: string) { removedName = name; },
        isRemote(name: string) { return name === 'remote-session'; },
        removeRemote(name: string) { removedRemoteName = name; },
        getAll() { return ['other']; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'current',
        mockRouter as any,
      );

      const disconnectHandler = regexHandlers.find(h => h.pattern.test('hub:disconnect:remote-session'));
      assert.ok(disconnectHandler, 'hub:disconnect handler should be registered');

      let answerText = '';
      const mockCtx = {
        match: 'hub:disconnect:remote-session'.match(/^hub:disconnect:(.+)$/),
        async answerCallbackQuery(opts?: { text?: string }) {
          answerText = opts?.text ?? '';
        },
      };

      await disconnectHandler.handler(mockCtx);

      // Should NOT have called sessionManager.stop or router.remove
      assert.equal(stoppedName, '', 'should not stop PTY for remote session');
      assert.equal(removedName, '', 'should not call router.remove for remote session');
      // Should have called removeRemote
      assert.equal(removedRemoteName, 'remote-session', 'should call removeRemote for remote session');
      assert.ok(answerText.includes('remote-session'), 'answer should mention the session name');
    });

    it('hub:disconnect sends sendExit on bridge before removeRemote for remote sessions', async () => {
      const regexHandlers: Array<{ pattern: RegExp; handler: (ctx: any) => Promise<void> }> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (data instanceof RegExp) {
            regexHandlers.push({ pattern: data, handler });
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      let exitCalled = false;
      let removedRemoteName = '';
      const callOrder: string[] = [];
      const mockBridge = {
        sendInput(_data: string) {},
        onOutput(_cb: (data: string) => void) {},
        requestRedraw() {},
        sendPromote() {},
        sendExit() { exitCalled = true; callOrder.push('sendExit'); },
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(name: string) { return name === 'remote-sess'; },
        removeRemote(name: string) { removedRemoteName = name; callOrder.push('removeRemote'); },
        getAll() { return ['other']; },
        getRemoteBridge(name: string) { return name === 'remote-sess' ? mockBridge : undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'current',
        mockRouter as any,
      );

      const disconnectHandler = regexHandlers.find(h => h.pattern.test('hub:disconnect:remote-sess'));
      assert.ok(disconnectHandler, 'hub:disconnect handler should be registered');

      const mockCtx = {
        match: 'hub:disconnect:remote-sess'.match(/^hub:disconnect:(.+)$/),
        async answerCallbackQuery(_opts?: unknown) {},
      };

      await disconnectHandler.handler(mockCtx);

      assert.ok(exitCalled, 'sendExit should be called on the bridge');
      assert.equal(removedRemoteName, 'remote-sess', 'removeRemote should be called');
      assert.deepEqual(callOrder, ['sendExit', 'removeRemote'], 'sendExit should be called before removeRemote');
    });

    it('registers catch-all handler on callback_query:data', () => {
      const registeredOn: string[] = [];
      const mockBot = {
        callbackQuery(_data: string | RegExp, _handler: unknown) {},
        on(filter: string, _handler: unknown) {
          registeredOn.push(filter);
        },
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test',
        mockRouter as any,
      );

      assert.ok(
        registeredOn.includes('callback_query:data'),
        'should register catch-all handler',
      );
    });

    it('registers hub:refresh handler when refreshHub is provided', () => {
      const registeredQueries: Array<string | RegExp> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, _handler: unknown) {
          registeredQueries.push(data);
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test',
        mockRouter as any,
        async () => {},
      );

      assert.ok(
        registeredQueries.includes('hub:refresh'),
        'should register hub:refresh handler',
      );
    });

    it('hub:refresh handler calls refreshHub and answers callback', async () => {
      let refreshCalled = false;
      const handlers: Map<string, (ctx: any) => Promise<void>> = new Map();
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (typeof data === 'string') {
            handlers.set(data, handler);
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test',
        mockRouter as any,
        async () => { refreshCalled = true; },
      );

      let answered = false;
      const mockCtx = {
        async answerCallbackQuery() { answered = true; },
      };

      const refreshHandler = handlers.get('hub:refresh');
      assert.ok(refreshHandler, 'hub:refresh handler should be registered');
      await refreshHandler(mockCtx);

      assert.ok(refreshCalled, 'refreshHub should be called');
      assert.ok(answered, 'answerCallbackQuery should be called');
    });

    it('registers hub:advanced handler when toggleAdvanced is provided', () => {
      const registeredQueries: Array<string | RegExp> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, _handler: unknown) {
          registeredQueries.push(data);
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test',
        mockRouter as any,
        async () => {},
        undefined,
        async () => {},
      );

      assert.ok(
        registeredQueries.includes('hub:advanced'),
        'should register hub:advanced handler',
      );
    });

    it('hub:advanced handler calls toggleAdvanced and answers callback', async () => {
      let toggleCalled = false;
      const handlers: Map<string, (ctx: any) => Promise<void>> = new Map();
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (typeof data === 'string') {
            handlers.set(data, handler);
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test',
        mockRouter as any,
        async () => {},
        undefined,
        async () => { toggleCalled = true; },
      );

      let answered = false;
      const mockCtx = {
        async answerCallbackQuery() { answered = true; },
      };

      const advancedHandler = handlers.get('hub:advanced');
      assert.ok(advancedHandler, 'hub:advanced handler should be registered');
      await advancedHandler(mockCtx);

      assert.ok(toggleCalled, 'toggleAdvanced should be called');
      assert.ok(answered, 'answerCallbackQuery should be called');
    });

    it('registers action:scroll-lock handler when scrollHandler is provided', () => {
      const registeredQueries: Array<string | RegExp> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, _handler: unknown) {
          registeredQueries.push(data);
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      const mockScrollHandler = {
        scrollUp() {},
        scrollDown() {},
        toggleLock() {},
        get scrollLocked() { return true; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test',
        mockRouter as any,
        undefined,
        mockScrollHandler,
      );

      assert.ok(
        registeredQueries.includes('action:scroll-lock'),
        'should register action:scroll-lock handler',
      );
    });

    it('action:scroll-lock handler calls toggleLock and updates keyboard', async () => {
      const handlers: Map<string, (ctx: any) => Promise<void>> = new Map();
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (typeof data === 'string') {
            handlers.set(data, handler);
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; },
        getRemoteBridge(_name: string) { return undefined; },
      };

      let toggleCalled = false;
      let locked = true;
      const mockScrollHandler = {
        scrollUp() {},
        scrollDown() {},
        toggleLock() { toggleCalled = true; locked = !locked; },
        get scrollLocked() { return locked; },
      };

      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'test',
        mockRouter as any,
        undefined,
        mockScrollHandler,
      );

      let editedMarkup: any = null;
      let answered = false;
      const mockCtx = {
        async editMessageReplyMarkup(opts: any) { editedMarkup = opts; },
        async answerCallbackQuery() { answered = true; },
      };

      const lockHandler = handlers.get('action:scroll-lock');
      assert.ok(lockHandler, 'action:scroll-lock handler should exist');
      await lockHandler(mockCtx);

      assert.ok(toggleCalled, 'toggleLock should be called');
      assert.ok(editedMarkup !== null, 'keyboard markup should be updated');
      assert.ok(answered, 'callback query should be answered');
    });

    it('hub:disconnect triggers refreshHub and onShutdown when no sessions remain', async () => {
      const regexHandlers: Array<{ pattern: RegExp; handler: (ctx: any) => Promise<void> }> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (data instanceof RegExp) {
            regexHandlers.push({ pattern: data, handler });
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return []; }, // empty after disconnect
        getRemoteBridge(_name: string) { return undefined; },
      };

      let shutdownCalled = false;
      let refreshHubCalled = false;
      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'last-session',
        mockRouter as any,
        async () => { refreshHubCalled = true; }, // refreshHub
        undefined, // scrollHandler
        undefined, // toggleAdvanced
        async () => { shutdownCalled = true; },
      );

      const disconnectHandler = regexHandlers.find(h => h.pattern.test('hub:disconnect:last-session'));
      assert.ok(disconnectHandler, 'hub:disconnect handler should be registered');

      const mockCtx = {
        match: 'hub:disconnect:last-session'.match(/^hub:disconnect:(.+)$/),
        async answerCallbackQuery(_opts?: unknown) {},
      };

      await disconnectHandler.handler(mockCtx);

      assert.ok(refreshHubCalled, 'refreshHub should be called when no sessions remain');
      assert.ok(shutdownCalled, 'onShutdown should be called when no sessions remain');
    });

    it('hub:disconnect does NOT trigger onShutdown when sessions remain', async () => {
      const regexHandlers: Array<{ pattern: RegExp; handler: (ctx: any) => Promise<void> }> = [];
      const mockBot = {
        callbackQuery(data: string | RegExp, handler: (ctx: any) => Promise<void>) {
          if (data instanceof RegExp) {
            regexHandlers.push({ pattern: data, handler });
          }
        },
        on(_filter: string, _handler: unknown) {},
      };

      const mockSm = {
        writeToSession(_name: string, _data: string) {},
        async stop(_name: string) {},
      };

      const mockRouter = {
        switchTo(_name: string) {},
        remove(_name: string) {},
        isRemote(_name: string) { return false; },
        removeRemote(_name: string) {},
        getAll() { return ['remaining-session']; }, // still has sessions
        getRemoteBridge(_name: string) { return undefined; },
      };

      let shutdownCalled = false;
      registerCallbackHandlers(
        mockBot as any,
        mockSm as any,
        () => 'doomed-session',
        mockRouter as any,
        undefined,
        undefined,
        undefined,
        async () => { shutdownCalled = true; },
      );

      const disconnectHandler = regexHandlers.find(h => h.pattern.test('hub:disconnect:doomed-session'));
      assert.ok(disconnectHandler);

      const mockCtx = {
        match: 'hub:disconnect:doomed-session'.match(/^hub:disconnect:(.+)$/),
        async answerCallbackQuery(_opts?: unknown) {},
      };

      await disconnectHandler.handler(mockCtx);

      assert.ok(!shutdownCalled, 'onShutdown should NOT be called when sessions remain');
    });
  });
});
