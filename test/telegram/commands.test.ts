import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { registerCommands } from '../../src/telegram/commands.js';
import type { Session } from '../../src/session/types.js';

/** Minimal mock for grammY Bot */
function createMockBot() {
  const registered: { command: string; handler: (ctx: unknown) => Promise<void> }[] = [];

  return {
    command(name: string, handler: (ctx: unknown) => Promise<void>) {
      registered.push({ command: name, handler });
    },
    registered,
  };
}

/** Create a fake Session object */
function fakeSession(name: string, status: Session['status'] = 'running'): Session {
  return {
    id: Math.floor(Math.random() * 1000),
    name,
    pid: 12345,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Minimal mock for SessionManager */
function createMockSessionManager(sessions: Session[] = []) {
  return {
    getActive(): Session[] {
      return sessions;
    },
  };
}

/** Minimal mock for HubRenderer */
function createMockHubRenderer() {
  let renderCount = 0;
  let lastRenderOpts: { forceNew?: boolean } | undefined = undefined;
  return {
    async render(opts?: { forceNew?: boolean }) {
      renderCount++;
      lastRenderOpts = opts;
    },
    get renderCount() {
      return renderCount;
    },
    get lastRenderOpts() {
      return lastRenderOpts;
    },
  };
}

/** Create a mock ctx that tracks reply calls */
function createMockCtx() {
  const replies: Array<{ text: string; opts?: unknown }> = [];
  return {
    async reply(text: string, opts?: unknown) {
      replies.push({ text, opts });
    },
    replies,
  };
}

describe('registerCommands', () => {
  it('registers /start, /help, and /hub commands', () => {
    const bot = createMockBot();
    const manager = createMockSessionManager();
    const hub = createMockHubRenderer();

    registerCommands(bot as any, manager as any, () => null, hub);

    const commands = bot.registered.map((r) => r.command);
    assert.ok(commands.includes('start'), '/start should be registered');
    assert.ok(commands.includes('help'), '/help should be registered');
    assert.ok(commands.includes('hub'), '/hub should be registered');
    assert.ok(!commands.includes('sessions'), '/sessions should NOT be registered');
  });

  describe('/start', () => {
    it('sends welcome message with HTML parse_mode', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      const hub = createMockHubRenderer();
      registerCommands(bot as any, manager as any, () => null, hub);

      const startCmd = bot.registered.find((r) => r.command === 'start')!;
      const ctx = createMockCtx();

      await startCmd.handler(ctx);

      assert.equal(ctx.replies.length, 1);
      const { text, opts } = ctx.replies[0];
      assert.ok(text.includes('<b>Nugget</b>'), 'should contain bot name in bold');
      assert.ok(text.includes('Control your Claude Code sessions'), 'should contain description');
      assert.ok(text.includes('Quick start'), 'should contain quick start section');
      assert.ok(text.includes('/help'), 'should mention /help');
      assert.deepEqual((opts as any)?.parse_mode, 'HTML');
    });

    it('triggers hub render after welcome message', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      const hub = createMockHubRenderer();
      registerCommands(bot as any, manager as any, () => null, hub);

      const startCmd = bot.registered.find((r) => r.command === 'start')!;
      const ctx = createMockCtx();

      await startCmd.handler(ctx);

      assert.equal(hub.renderCount, 1, 'hub.render() should be called once');
    });

    it('works without hubRenderer (backward compat)', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      registerCommands(bot as any, manager as any, () => null);

      const startCmd = bot.registered.find((r) => r.command === 'start')!;
      const ctx = createMockCtx();

      // Should not throw even without hubRenderer
      await startCmd.handler(ctx);

      assert.equal(ctx.replies.length, 1);
      assert.ok(ctx.replies[0].text.includes('Nugget'));
    });
  });

  describe('/help', () => {
    it('sends command list with HTML parse_mode', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      registerCommands(bot as any, manager as any, () => null);

      const helpCmd = bot.registered.find((r) => r.command === 'help')!;
      const ctx = createMockCtx();

      await helpCmd.handler(ctx);

      assert.equal(ctx.replies.length, 1);
      const { text, opts } = ctx.replies[0];
      assert.ok(text.includes('<b>Commands</b>'), 'should contain Commands header');
      assert.ok(text.includes('/start'), 'should list /start');
      assert.ok(text.includes('/hub'), 'should list /hub');
      assert.ok(!text.includes('/sessions'), '/sessions should NOT be in help text');
      assert.ok(text.includes('/controls'), 'should list /controls');
      assert.ok(text.includes('/help'), 'should list /help');
      assert.ok(text.includes('<b>Inline buttons</b>'), 'should have inline buttons section');
      assert.ok(text.includes('<b>Text input</b>'), 'should have text input section');
      assert.deepEqual((opts as any)?.parse_mode, 'HTML');
    });
  });

  describe('/hub', () => {
    it('triggers hub render when hubRenderer is provided', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      const hub = createMockHubRenderer();
      registerCommands(bot as any, manager as any, () => null, hub);

      const hubCmd = bot.registered.find((r) => r.command === 'hub')!;
      const ctx = createMockCtx();

      await hubCmd.handler(ctx);

      assert.equal(hub.renderCount, 1, 'hub.render() should be called');
      assert.equal(ctx.replies.length, 0, 'should not reply with text when hub renders');
    });

    it('/hub passes forceNew: true to hubRenderer.render()', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      const hub = createMockHubRenderer();
      registerCommands(bot as any, manager as any, () => null, hub);

      const hubCmd = bot.registered.find((r) => r.command === 'hub')!;
      const ctx = createMockCtx();

      await hubCmd.handler(ctx);

      assert.equal(hub.renderCount, 1, 'hub.render() should be called');
      assert.deepEqual(hub.lastRenderOpts, { forceNew: true }, 'should pass forceNew: true');
    });

    it('replies with fallback when hubRenderer is not provided', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      registerCommands(bot as any, manager as any, () => null);

      const hubCmd = bot.registered.find((r) => r.command === 'hub')!;
      const ctx = createMockCtx();

      await hubCmd.handler(ctx);

      assert.equal(ctx.replies.length, 1);
      assert.ok(ctx.replies[0].text.includes('not available'));
    });

    it('replies with error when hubRenderer.render() throws', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      const hub = {
        async render() { throw new Error('Telegram API error'); },
      };
      registerCommands(bot as any, manager as any, () => null, hub);

      const hubCmd = bot.registered.find((r) => r.command === 'hub')!;
      const ctx = createMockCtx();

      await hubCmd.handler(ctx);

      assert.equal(ctx.replies.length, 1);
      assert.ok(ctx.replies[0].text.includes('Failed to render hub'));
    });
  });

  describe('delete keyboard on ephemeral responses', () => {
    it('/start reply includes delete button inline keyboard', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      const hub = createMockHubRenderer();
      registerCommands(bot as any, manager as any, () => null, hub);

      const startCmd = bot.registered.find((r) => r.command === 'start')!;
      const ctx = createMockCtx();
      await startCmd.handler(ctx);

      const opts = ctx.replies[0].opts as any;
      assert.ok(opts?.reply_markup, '/start reply should have reply_markup');
      const keyboard = opts.reply_markup.inline_keyboard;
      assert.ok(Array.isArray(keyboard), 'reply_markup should have inline_keyboard array');
      const deleteBtn = keyboard.flat().find((b: any) => b.callback_data === 'action:delete');
      assert.ok(deleteBtn, 'should include action:delete button');
    });

    it('/help reply includes delete button inline keyboard', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      registerCommands(bot as any, manager as any, () => null);

      const helpCmd = bot.registered.find((r) => r.command === 'help')!;
      const ctx = createMockCtx();
      await helpCmd.handler(ctx);

      const opts = ctx.replies[0].opts as any;
      assert.ok(opts?.reply_markup, '/help reply should have reply_markup');
      const deleteBtn = opts.reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data === 'action:delete');
      assert.ok(deleteBtn, 'should include action:delete button');
    });

  });

  describe('/automate', () => {
    it('triggers automationHub.render({ forceNew: true }) when automationHub is provided', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      const hub = createMockHubRenderer();
      const automationHub = createMockHubRenderer();
      registerCommands(bot as any, manager as any, () => null, hub, undefined, undefined, automationHub);

      const automateCmd = bot.registered.find((r) => r.command === 'automate')!;
      assert.ok(automateCmd, '/automate should be registered');

      const ctx = createMockCtx();
      await automateCmd.handler(ctx);

      assert.equal(automationHub.renderCount, 1, 'automationHub.render() should be called once');
      assert.deepEqual(automationHub.lastRenderOpts, { forceNew: true }, 'should pass forceNew: true');
      assert.equal(ctx.replies.length, 0, 'should not reply with text when automation hub renders');
    });

    it('replies "Automation hub not available." when automationHub is not provided', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      registerCommands(bot as any, manager as any, () => null);

      const automateCmd = bot.registered.find((r) => r.command === 'automate')!;
      assert.ok(automateCmd, '/automate should be registered');

      const ctx = createMockCtx();
      await automateCmd.handler(ctx);

      assert.equal(ctx.replies.length, 1);
      assert.ok(ctx.replies[0].text.includes('Automation hub not available'));
    });

    it('replies with error when automationHub.render() throws', async () => {
      const bot = createMockBot();
      const manager = createMockSessionManager();
      const automationHub = {
        async render() { throw new Error('Telegram API error'); },
      };
      registerCommands(bot as any, manager as any, () => null, undefined, undefined, undefined, automationHub);

      const automateCmd = bot.registered.find((r) => r.command === 'automate')!;
      const ctx = createMockCtx();

      await automateCmd.handler(ctx);

      assert.equal(ctx.replies.length, 1);
      assert.ok(ctx.replies[0].text.includes('Failed to render automation hub'));
    });
  });

  describe('/settings Confirm Enter toggle', () => {
    /** Minimal mock for SettingsStore */
    function createMockSettingsStore(overrides: Record<string, boolean | number> = {}) {
      const store: Record<string, string> = {};
      for (const [k, v] of Object.entries(overrides)) {
        store[k] = String(v);
      }
      return {
        get(key: string): boolean { return store[key] === 'true'; },
        set(key: string, value: boolean) { store[key] = value ? 'true' : 'false'; },
        getNumber(key: string, defaultValue: number): number {
          const v = store[key];
          if (v === undefined) return defaultValue;
          const n = parseInt(v, 10);
          return Number.isNaN(n) ? defaultValue : n;
        },
        setNumber(key: string, value: number) { store[key] = String(value); },
        getUpdatedAt(_key: string): string | null { return null; },
      };
    }

    function createMockBotWithCallbacks() {
      const commands: { command: string; handler: (ctx: any) => Promise<void> }[] = [];
      const callbacks: { trigger: string; handler: (ctx: any) => Promise<void> }[] = [];
      return {
        command(name: string, handler: (ctx: any) => Promise<void>) {
          commands.push({ command: name, handler });
        },
        callbackQuery(trigger: string, handler: (ctx: any) => Promise<void>) {
          callbacks.push({ trigger, handler });
        },
        on(_filter: string, _handler: unknown) {},
        commands,
        callbacks,
      };
    }

    it('buildSettingsMessage includes "Confirm Enter" line showing ON/OFF state', async () => {
      const bot = createMockBotWithCallbacks();
      const manager = createMockSessionManager();
      const settingsStore = createMockSettingsStore({ enter_confirmation: true });
      registerCommands(bot as any, manager as any, () => null, undefined, undefined, settingsStore as any);

      const settingsCmd = bot.commands.find(c => c.command === 'settings')!;
      assert.ok(settingsCmd, '/settings should be registered');

      const replies: any[] = [];
      const ctx = {
        async reply(text: string, opts?: unknown) { replies.push({ text, opts }); return { message_id: 1 }; },
        async deleteMessage() {},
      };
      await settingsCmd.handler(ctx);

      const text = replies[0].text as string;
      assert.ok(text.includes('Confirm Enter'), 'settings message should include "Confirm Enter"');
      assert.ok(text.includes('ON'), 'should show ON when enter_confirmation is true');
    });

    it('buildSettingsMessage keyboard includes toggle button for enter_confirmation', async () => {
      const bot = createMockBotWithCallbacks();
      const manager = createMockSessionManager();
      const settingsStore = createMockSettingsStore({ enter_confirmation: false });
      registerCommands(bot as any, manager as any, () => null, undefined, undefined, settingsStore as any);

      const settingsCmd = bot.commands.find(c => c.command === 'settings')!;
      const replies: any[] = [];
      const ctx = {
        async reply(text: string, opts?: unknown) { replies.push({ text, opts }); return { message_id: 1 }; },
        async deleteMessage() {},
      };
      await settingsCmd.handler(ctx);

      const keyboard = (replies[0].opts as any).reply_markup.inline_keyboard;
      const allButtons = keyboard.flat();
      const toggleBtn = allButtons.find((b: any) => b.callback_data === 'settings:toggle-enter-confirmation');
      assert.ok(toggleBtn, 'should have a toggle button for enter_confirmation');
    });

    it('settings:toggle-enter-confirmation callback toggles the setting and re-renders', async () => {
      const bot = createMockBotWithCallbacks();
      const manager = createMockSessionManager();
      const settingsStore = createMockSettingsStore({ enter_confirmation: false });
      registerCommands(bot as any, manager as any, () => null, undefined, undefined, settingsStore as any);

      const toggleHandler = bot.callbacks.find(c => c.trigger === 'settings:toggle-enter-confirmation');
      assert.ok(toggleHandler, 'toggle-enter-confirmation callback should be registered');

      let editedText = '';
      let answerText = '';
      const ctx = {
        async editMessageText(text: string, _opts?: unknown) { editedText = text; },
        async editMessageReplyMarkup(_markup: unknown) {},
        async answerCallbackQuery(opts?: { text?: string }) { answerText = opts?.text ?? ''; },
        async deleteMessage() {},
      };

      await toggleHandler.handler(ctx);

      assert.ok(settingsStore.get('enter_confirmation'), 'enter_confirmation should be toggled to true');
      assert.ok(editedText.includes('Confirm Enter'), 're-rendered message should include Confirm Enter');
      assert.ok(answerText.includes('ON'), 'answer should indicate new state ON');
    });
  });
});
