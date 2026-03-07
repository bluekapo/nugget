import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { SessionManager } from '../session/manager.js';
import type { SessionRouter } from '../session/router.js';

/** Inline button definitions for common Claude Code actions. */
export const ACTION_BUTTONS = {
  scrollUp:   { label: '\u2B06 Scroll Up',   data: 'action:scroll-up',   input: '\x1b[5~' },
  scrollDown: { label: '\u2B07 Scroll Down', data: 'action:scroll-down', input: '\x1b[6~' },
  clear:      { label: '\uD83D\uDDD1 /clear',     data: 'action:clear',       input: '/clear' },
  backspace:  { label: '\u232B Bksp',   data: 'action:backspace',    input: '\x7f' },
  arrowUp:    { label: '\u2B06 Up',       data: 'action:arrow-up',    input: '\x1b[A' },
  arrowDown:  { label: '\u2B07 Down',     data: 'action:arrow-down',  input: '\x1b[B' },
  enter:      { label: '\u21A9 Enter',    data: 'action:enter',       input: '\r' },
  arrowLeft:  { label: '\u2B05 Left',     data: 'action:arrow-left',  input: '\x1b[D' },
  arrowRight: { label: '\u27A1 Right',    data: 'action:arrow-right', input: '\x1b[C' },
  escape:     { label: '\u238B Esc',      data: 'action:escape',      input: '\x1b' },
  clearInput: { label: '\u2716 Clear',   data: 'action:clear-input', input: '\x7f' },
} as const;

/** Build an InlineKeyboard for CLI output messages (no Delete button).
 *  Row 1: Scroll Up / Lock toggle / Scroll Down, Row 2: Clear-input + /clear + Enter, Row 3: Esc/Up/Bksp, Row 4: Left/Down/Right.
 *  Lock button shows current state: locked (auto-scroll on) or unlocked (manual scroll). */
export function buildCLIKeyboard(locked = true): InlineKeyboard {
  const lockLabel = locked ? '\uD83D\uDD34\uD83D\uDD12' : '\uD83D\uDFE2\uD83D\uDD13';
  const scrollUpLabel = locked ? '\uD83D\uDD12 \u2B06 Scroll Up' : '\u2B06 Scroll Up';
  const scrollDownLabel = locked ? '\uD83D\uDD12 \u2B07 Scroll Down' : '\u2B07 Scroll Down';
  return new InlineKeyboard()
    .text(scrollUpLabel, ACTION_BUTTONS.scrollUp.data)
    .text(lockLabel, 'action:scroll-lock')
    .text(scrollDownLabel, ACTION_BUTTONS.scrollDown.data)
    .row()
    .text(ACTION_BUTTONS.clearInput.label, ACTION_BUTTONS.clearInput.data)
    .text(ACTION_BUTTONS.clear.label, ACTION_BUTTONS.clear.data)
    .text(ACTION_BUTTONS.enter.label, ACTION_BUTTONS.enter.data)
    .row()
    .text(ACTION_BUTTONS.escape.label, ACTION_BUTTONS.escape.data)
    .text(ACTION_BUTTONS.arrowUp.label, ACTION_BUTTONS.arrowUp.data)
    .text(ACTION_BUTTONS.backspace.label, ACTION_BUTTONS.backspace.data)
    .row()
    .text(ACTION_BUTTONS.arrowLeft.label, ACTION_BUTTONS.arrowLeft.data)
    .text(ACTION_BUTTONS.arrowDown.label, ACTION_BUTTONS.arrowDown.data)
    .text(ACTION_BUTTONS.arrowRight.label, ACTION_BUTTONS.arrowRight.data);
}

/** Build an InlineKeyboard for /controls command (includes Delete button).
 *  Row 1: Scroll Up / Lock toggle / Scroll Down, Row 2: Clear-input + /clear + Enter, Row 3: Esc/Up/Bksp, Row 4: Left/Down/Right, Row 5: Delete.
 *  Lock button shows current state: locked (auto-scroll on) or unlocked (manual scroll). */
export function buildControlsKeyboard(locked = true): InlineKeyboard {
  const lockLabel = locked ? '\uD83D\uDD34\uD83D\uDD12' : '\uD83D\uDFE2\uD83D\uDD13';
  const scrollUpLabel = locked ? '\uD83D\uDD12 \u2B06 Scroll Up' : '\u2B06 Scroll Up';
  const scrollDownLabel = locked ? '\uD83D\uDD12 \u2B07 Scroll Down' : '\u2B07 Scroll Down';
  return new InlineKeyboard()
    .text(scrollUpLabel, ACTION_BUTTONS.scrollUp.data)
    .text(lockLabel, 'action:scroll-lock')
    .text(scrollDownLabel, ACTION_BUTTONS.scrollDown.data)
    .row()
    .text(ACTION_BUTTONS.clearInput.label, ACTION_BUTTONS.clearInput.data)
    .text(ACTION_BUTTONS.clear.label, ACTION_BUTTONS.clear.data)
    .text(ACTION_BUTTONS.enter.label, ACTION_BUTTONS.enter.data)
    .row()
    .text(ACTION_BUTTONS.escape.label, ACTION_BUTTONS.escape.data)
    .text(ACTION_BUTTONS.arrowUp.label, ACTION_BUTTONS.arrowUp.data)
    .text(ACTION_BUTTONS.backspace.label, ACTION_BUTTONS.backspace.data)
    .row()
    .text(ACTION_BUTTONS.arrowLeft.label, ACTION_BUTTONS.arrowLeft.data)
    .text(ACTION_BUTTONS.arrowDown.label, ACTION_BUTTONS.arrowDown.data)
    .text(ACTION_BUTTONS.arrowRight.label, ACTION_BUTTONS.arrowRight.data)
    .row()
    .text('🗑 Delete', 'action:delete');
}

/**
 * Register callback query handlers for action buttons and hub buttons.
 * Also registers a catch-all handler to prevent stuck loading spinners.
 */
export function registerCallbackHandlers(
  bot: Bot,
  sessionManager: SessionManager,
  getActiveSession: () => string | null,
  router: Pick<SessionRouter, 'switchTo' | 'remove' | 'isRemote' | 'removeRemote' | 'getAll' | 'getRemoteBridge'>,
  refreshHub?: () => Promise<void>,
  scrollHandler?: { scrollUp(): void; scrollDown(): void; toggleLock(): void; readonly scrollLocked: boolean },
  toggleAdvanced?: () => Promise<void>,
  onShutdown?: () => Promise<void>,
  deleteHub?: () => Promise<void>,
  automationHub?: { handleCallback(data: string): Promise<string>; render(): Promise<void> },
): void {
  // Delete button -- removes the bot message it's attached to (no session required)
  bot.callbackQuery('action:delete', async (ctx) => {
    try {
      await ctx.deleteMessage();
    } catch {
      // Message may already be deleted
    }
    await ctx.answerCallbackQuery();
  });

  // Scroll lock toggle -- dedicated handler outside the ACTION_BUTTONS loop
  bot.callbackQuery('action:scroll-lock', async (ctx) => {
    if (!scrollHandler) { await ctx.answerCallbackQuery(); return; }
    scrollHandler.toggleLock();
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: buildCLIKeyboard(scrollHandler.scrollLocked) });
    } catch { /* message may not be editable */ }
    await ctx.answerCallbackQuery();
  });

  // Action buttons -- resolve session dynamically
  for (const action of Object.values(ACTION_BUTTONS)) {
    bot.callbackQuery(action.data, async (ctx) => {
      const sessionName = getActiveSession();
      if (sessionName === null) {
        await ctx.answerCallbackQuery({ text: 'No active session' });
        return;
      }

      // Scroll buttons: handled by ScreenCapture, not PTY
      if (scrollHandler && (action.data === 'action:scroll-up' || action.data === 'action:scroll-down')) {
        if (action.data === 'action:scroll-up') {
          scrollHandler.scrollUp();
          // After scrollUp, always unlocked — update keyboard to remove lock emoji
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: buildCLIKeyboard(false) });
          } catch { /* message may not be editable */ }
        } else {
          scrollHandler.scrollDown();
          // After scrollDown, check if re-locked (at bottom) — update keyboard accordingly
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: buildCLIKeyboard(scrollHandler.scrollLocked) });
          } catch { /* message may not be editable */ }
        }
        await ctx.answerCallbackQuery();
        return;
      }

      // Clear input: send End key + many backspaces to erase typed text
      if (action.data === 'action:clear-input') {
        sessionManager.writeToSession(sessionName, '\x1b[F' + '\x7f'.repeat(300));
        await ctx.answerCallbackQuery();
        return;
      }

      sessionManager.writeToSession(sessionName, action.input);
      await ctx.answerCallbackQuery();
    });
  }

  // Hub: switch session
  bot.callbackQuery(/^hub:switch:(.+)$/, async (ctx) => {
    const name = ctx.match![1];
    router.switchTo(name);
    await ctx.answerCallbackQuery({ text: `Switched to ${name}` });
  });

  // Hub: disconnect session
  bot.callbackQuery(/^hub:disconnect:(.+)$/, async (ctx) => {
    const name = ctx.match![1];
    if (router.isRemote(name)) {
      // Remote session: send exit command to kill the secondary, then remove from router
      const bridge = router.getRemoteBridge(name);
      if (bridge) bridge.sendExit();
      router.removeRemote(name);
    } else {
      // Local session: stop PTY — the session:exit bus handler in index.ts
      // will call router.remove(name), so we do NOT call it here to avoid double-remove
      try {
        await sessionManager.stop(name);
      } catch {
        // Session may have already exited
      }
    }
    await ctx.answerCallbackQuery({ text: `Disconnected ${name}` });

    // If no sessions remain, refresh hub (shows empty state) then trigger shutdown
    if (router.getAll().length === 0) {
      if (refreshHub) await refreshHub();
      if (onShutdown) await onShutdown();
    } else {
      // Refresh hub to show updated state
      if (refreshHub) await refreshHub();
    }
  });

  // Hub: refresh
  if (refreshHub) {
    bot.callbackQuery('hub:refresh', async (ctx) => {
      await refreshHub();
      await ctx.answerCallbackQuery();
    });
  }

  // Hub: toggle advanced view
  if (toggleAdvanced) {
    bot.callbackQuery('hub:advanced', async (ctx) => {
      await toggleAdvanced();
      await ctx.answerCallbackQuery();
    });
  }

  // Automation hub callbacks
  if (automationHub) {
    bot.callbackQuery(/^auto:/, async (ctx) => {
      const data = ctx.callbackQuery.data;
      const text = await automationHub.handleCallback(data);
      await ctx.answerCallbackQuery({ text });
    });
  }

  // Catch-all for unknown callbacks -- prevent stuck loading animation
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
