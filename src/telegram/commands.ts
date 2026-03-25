import type { SessionManager } from '../session/manager.js';
import type { SettingsStore } from '../db/settings-store.js';
import { logInfo, logError } from '../logging/logger.js';
import { isNotModifiedError } from './hub.js';

/**
 * Tracks the last ephemeral bot message so it can be deleted when a new command is issued.
 * Prevents old /start, /help replies from piling up in the chat.
 */
export class EphemeralTracker {
  private lastMessageId: number | null = null;

  constructor(
    private readonly api: { deleteMessage(chatId: number, messageId: number): Promise<unknown> },
    private readonly chatId: number,
  ) {}

  async track(messageId: number): Promise<void> {
    if (this.lastMessageId !== null) {
      try {
        await this.api.deleteMessage(this.chatId, this.lastMessageId);
      } catch {
        // Message may already be deleted
      }
    }
    this.lastMessageId = messageId;
  }
}

/**
 * Register Telegram bot commands.
 *
 * @param bot - grammY Bot instance (or any object with a .command() method)
 * @param sessionManager - SessionManager to query active sessions
 * @param getActiveSession - Returns the currently active session name, or null
 * @param hubRenderer - HubRenderer to render the sessions hub (optional for backward compat)
 */
/** GSD workflow command mapping: Telegram command name -> PTY text prefix. */
const GSD_COMMANDS: Record<string, string> = {
  execute_phase: '/gsd:execute-phase',
  plan_phase: '/gsd:plan-phase',
  validate_phase: '/gsd:validate-phase',
  audit_milestone: '/gsd:audit-milestone',
  complete_milestone: '/gsd:complete-milestone',
  quick: '/gsd:quick',
};

export function registerCommands(
  bot: {
    command(name: string, handler: (ctx: { reply(text: string, opts?: unknown): Promise<unknown>; deleteMessage(): Promise<boolean> }) => Promise<void>): void;
    callbackQuery(trigger: string, handler: (ctx: {
      answerCallbackQuery(opts?: { text?: string }): Promise<unknown>;
      editMessageText(text: string, opts?: unknown): Promise<unknown>;
      editMessageReplyMarkup(markup: unknown): Promise<unknown>;
      deleteMessage(): Promise<unknown>;
    }) => Promise<void>): void;
  },
  sessionManager: Pick<SessionManager, 'getActive'>,
  getActiveSession: () => string | null,
  hubRenderer?: { render(opts?: { forceNew?: boolean }): Promise<void> },
  ephemeralTracker?: EphemeralTracker,
  settingsStore?: SettingsStore,
  writeToSession?: (name: string, data: string) => void,
): void {
  // /start - Welcome message and quick start guide
  bot.command('start', async (ctx) => {
    const welcome = [
      '<b>Nugget</b>',
      '',
      'Control your Claude Code sessions from Telegram.',
      '',
      '<b>Quick start:</b>',
      '- Type any text to send it to the active session',
      '- Use the inline buttons to approve/reject/navigate',
      '- Use /hub to see all sessions',
      '',
      'Type /help for all commands.',
    ].join('\n');

    const result = await ctx.reply(welcome, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🗑 Delete', callback_data: 'action:delete' }]] },
    }) as { message_id: number };
    await ephemeralTracker?.track(result.message_id);

    if (hubRenderer) {
      await hubRenderer.render();
    }

    try { await ctx.deleteMessage(); } catch { /* ignore */ }
  });

  // /help - Command reference
  bot.command('help', async (ctx) => {
    const help = [
      '<b>Commands</b>',
      '',
      '/start - Welcome message and quick start guide',
      '/hub - Show sessions hub with switch/disconnect buttons',
      '/help - This help message',
      '',
      '<b>Inline buttons</b>',
      'Scroll Up/Down - Scroll terminal output',
      '/clear - Clear Claude\'s context window',
      'Bksp - Send backspace',
      'Up/Down - Navigate history',
      'Enter - Send enter key',
      '',
      '<b>Text input</b>',
      'Any text message is forwarded to the active session.',
    ].join('\n');

    const result = await ctx.reply(help, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🗑 Delete', callback_data: 'action:delete' }]] },
    }) as { message_id: number };
    await ephemeralTracker?.track(result.message_id);

    try { await ctx.deleteMessage(); } catch { /* ignore */ }
  });

  // /hub - Interactive sessions hub (rendered with inline keyboard)
  bot.command('hub', async (ctx) => {
    logInfo('/hub command received');
    if (hubRenderer) {
      try {
        await hubRenderer.render({ forceNew: true });
      } catch (err) {
        logError('/hub render failed:', err);
        await ctx.reply('Failed to render hub.');
      }
    } else {
      await ctx.reply('Hub renderer not available.');
    }

    try { await ctx.deleteMessage(); } catch { /* ignore */ }
  });

  // /settings - Notification preferences with inline toggle
  if (settingsStore) {
    bot.command('settings', async (ctx) => {
      const { text, keyboard } = buildSettingsMessage(settingsStore);
      const result = await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }) as { message_id: number };
      await ephemeralTracker?.track(result.message_id);
      try { await ctx.deleteMessage(); } catch { /* ignore */ }
    });

    // Toggle callback: edit the same message in-place
    bot.callbackQuery('settings:toggle-notifications', async (ctx) => {
      const current = settingsStore.get('notifications');
      settingsStore.set('notifications', !current);
      const { text, keyboard } = buildSettingsMessage(settingsStore);
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch (err) {
        if (!isNotModifiedError(err)) {
          logError('Settings editMessageText failed:', err);
        }
      }
      await ctx.answerCallbackQuery({ text: `Notifications ${!current ? 'ON' : 'OFF'}` });
    });

    // Toggle enter confirmation callback: edit the same message in-place
    bot.callbackQuery('settings:toggle-enter-confirmation', async (ctx) => {
      const current = settingsStore.get('enter_confirmation');
      settingsStore.set('enter_confirmation', !current);
      const { text, keyboard } = buildSettingsMessage(settingsStore);
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch (err) {
        if (!isNotModifiedError(err)) {
          logError('Settings editMessageText failed:', err);
        }
      }
      await ctx.answerCallbackQuery({ text: `Confirm Enter ${!current ? 'ON' : 'OFF'}` });
    });

    // Cycle limit decrease: subtract 10, clamp to minimum 10
    bot.callbackQuery('settings:cycle-limit-dec', async (ctx) => {
      const current = settingsStore.getNumber('cycle_limit', 100);
      const newValue = Math.max(10, current - 10);
      settingsStore.setNumber('cycle_limit', newValue);
      const { text, keyboard } = buildSettingsMessage(settingsStore);
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch (err) {
        if (!isNotModifiedError(err)) {
          logError('Settings editMessageText failed:', err);
        }
      }
      await ctx.answerCallbackQuery({ text: `Cycle limit: ${newValue}` });
    });

    // Cycle limit increase: add 10, clamp to maximum 1000
    bot.callbackQuery('settings:cycle-limit-inc', async (ctx) => {
      const current = settingsStore.getNumber('cycle_limit', 100);
      const newValue = Math.min(1000, current + 10);
      settingsStore.setNumber('cycle_limit', newValue);
      const { text, keyboard } = buildSettingsMessage(settingsStore);
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch (err) {
        if (!isNotModifiedError(err)) {
          logError('Settings editMessageText failed:', err);
        }
      }
      await ctx.answerCallbackQuery({ text: `Cycle limit: ${newValue}` });
    });

    // Cycle limit noop: just show current value
    bot.callbackQuery('settings:cycle-limit-noop', async (ctx) => {
      const current = settingsStore.getNumber('cycle_limit', 100);
      await ctx.answerCallbackQuery({ text: `Cycle limit: ${current}` });
    });
  }

  // GSD workflow quick commands: forward /gsd:<cmd> to active worker session
  if (writeToSession) {
    for (const [cmdName, gsdCommand] of Object.entries(GSD_COMMANDS)) {
      bot.command(cmdName, async (ctx: { message?: { text?: string }; reply(text: string, opts?: unknown): Promise<unknown>; deleteMessage(): Promise<boolean> }) => {
        const args = ctx.message?.text?.split(/\s+/).slice(1).join(' ') ?? '';
        const session = getActiveSession();
        if (!session) {
          await ctx.reply('No active session. Use /hub to see available sessions.');
          return;
        }
        writeToSession(session, gsdCommand + (args ? ' ' + args : '') + '\n');
        try { await ctx.deleteMessage(); } catch { /* ignore */ }
      });
    }
  }

}

/** Build settings message text and inline keyboard. */
function buildSettingsMessage(store: SettingsStore): {
  text: string;
  keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
} {
  const enabled = store.get('notifications');
  const updatedAt = store.getUpdatedAt('notifications');

  let lastUpdated = 'never';
  if (updatedAt) {
    try {
      const d = new Date(updatedAt);
      lastUpdated = d.toLocaleString('en-GB', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      lastUpdated = updatedAt.replace('T', ' ').slice(0, 16);
    }
  }

  const cycleLimit = store.getNumber('cycle_limit', 100);

  const enterConfirm = store.get('enter_confirmation');

  const text = [
    '<b>Settings</b>',
    '',
    `Notifications: <b>${enabled ? 'ON' : 'OFF'}</b>`,
    `Confirm Enter: <b>${enterConfirm ? 'ON' : 'OFF'}</b>`,
    `Cycle limit: <b>${cycleLimit}</b>`,
    `Last updated: ${lastUpdated}`,
  ].join('\n');

  const toggleLabel = enabled ? '\uD83D\uDD15 Turn OFF' : '\uD83D\uDD14 Turn ON';
  const enterConfirmLabel = enterConfirm ? '\uD83D\uDEE1 Confirm Enter: OFF' : '\uD83D\uDEE1 Confirm Enter: ON';
  const keyboard = {
    inline_keyboard: [
      [{ text: toggleLabel, callback_data: 'settings:toggle-notifications' }],
      [{ text: enterConfirmLabel, callback_data: 'settings:toggle-enter-confirmation' }],
      [
        { text: '-10', callback_data: 'settings:cycle-limit-dec' },
        { text: String(cycleLimit), callback_data: 'settings:cycle-limit-noop' },
        { text: '+10', callback_data: 'settings:cycle-limit-inc' },
      ],
      [{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }],
    ],
  };

  return { text, keyboard };
}
