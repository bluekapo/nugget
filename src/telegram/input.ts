import type { Context, NextFunction } from 'grammy';
import type { SessionManager } from '../session/manager.js';
import type { CommandAllowlist } from '../security/allowlist.js';

/**
 * Handles text messages from Telegram and forwards them to the active PTY session.
 *
 * Pipeline: Telegram text message -> allowlist check -> writeToSession(name, text)
 */
export class TelegramInputHandler {
  /** Commands registered with the bot that grammY should handle. */
  private static readonly BOT_COMMANDS = new Set([
    'start', 'help', 'hub', 'controls', 'settings',
  ]);

  constructor(
    private sessionManager: SessionManager,
    private getActiveSession: () => string | null,
    private allowlist: CommandAllowlist,
    private automationHub?: {
      isAwaitingTaskInput(): boolean;
      submitTaskForReview(text: string): Promise<void>;
      render(): Promise<void>;
    },
  ) {}

  /** Returns a grammY middleware function for message:text events. */
  handler() {
    return async (ctx: Context, next: NextFunction): Promise<void> => {
      const text = ctx.message?.text;
      if (!text) return next();

      // Only let grammY handle known bot commands; forward everything else to PTY
      if (text.startsWith('/')) {
        const match = text.match(/^\/([a-zA-Z0-9_]+)/);
        const command = match?.[1];
        if (command && TelegramInputHandler.BOT_COMMANDS.has(command)) {
          return next(); // Let grammY handle this bot command
        }
        // Not a bot command — fall through to forward to PTY
      }

      // Intercept text input for automation hub task description
      if (this.automationHub?.isAwaitingTaskInput()) {
        await this.automationHub.submitTaskForReview(text);
        try { await ctx.deleteMessage(); } catch { /* ignore */ }
        return;
      }

      const sessionName = this.getActiveSession();
      if (sessionName === null) {
        await ctx.reply('No active session. Use /hub to see available sessions.');
        return;
      }

      if (!this.allowlist.isAllowed(text)) {
        await ctx.reply(`Command not allowed. Allowed: ${this.allowlist.describe()}`);
        try { await ctx.deleteMessage(); } catch { /* ignore */ }
        return;
      }

      this.sessionManager.writeToSession(sessionName, text);
      // Auto-delete the user's message to keep chat clean
      try {
        await ctx.deleteMessage();
      } catch {
        // Ignore — message may already be deleted or bot lacks permission
      }
    };
  }
}
