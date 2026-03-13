import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { SessionManager } from '../session/manager.js';
import type { SessionRouter } from '../session/router.js';
import type { SettingsStore } from '../db/settings-store.js';

/** Safely answer a callback query, ignoring "query is too old" and "query ID invalid" errors.
 *  These occur when a user clicks an inline button after Telegram's ~30s window expires. */
export async function safeAnswer(
  ctx: { answerCallbackQuery: (opts?: { text?: string }) => Promise<unknown> },
  opts?: { text?: string },
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(opts);
  } catch {
    // "query is too old" (>30s) and "query ID invalid" are expected/benign.
    // Swallow silently — do not crash the bot.
  }
}

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
export function buildCLIKeyboard(locked = true, enterConfirmation = false): InlineKeyboard {
  const lockLabel = locked ? '\uD83D\uDD34\uD83D\uDD12' : '\uD83D\uDFE2\uD83D\uDD13';
  const scrollUpLabel = locked ? '\uD83D\uDD12 \u2B06 Scroll Up' : '\u2B06 Scroll Up';
  const scrollDownLabel = locked ? '\uD83D\uDD12 \u2B07 Scroll Down' : '\u2B07 Scroll Down';
  const enterLabel = enterConfirmation ? '\uD83D\uDEE1 \u21A9 Enter' : ACTION_BUTTONS.enter.label;
  return new InlineKeyboard()
    .text(scrollUpLabel, ACTION_BUTTONS.scrollUp.data)
    .text(lockLabel, 'action:scroll-lock')
    .text(scrollDownLabel, ACTION_BUTTONS.scrollDown.data)
    .row()
    .text(ACTION_BUTTONS.clearInput.label, ACTION_BUTTONS.clearInput.data)
    .text(ACTION_BUTTONS.clear.label, ACTION_BUTTONS.clear.data)
    .text(enterLabel, ACTION_BUTTONS.enter.data)
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
export function buildControlsKeyboard(locked = true, enterConfirmation = false): InlineKeyboard {
  const lockLabel = locked ? '\uD83D\uDD34\uD83D\uDD12' : '\uD83D\uDFE2\uD83D\uDD13';
  const scrollUpLabel = locked ? '\uD83D\uDD12 \u2B06 Scroll Up' : '\u2B06 Scroll Up';
  const scrollDownLabel = locked ? '\uD83D\uDD12 \u2B07 Scroll Down' : '\u2B07 Scroll Down';
  const enterLabel = enterConfirmation ? '\uD83D\uDEE1 \u21A9 Enter' : ACTION_BUTTONS.enter.label;
  return new InlineKeyboard()
    .text(scrollUpLabel, ACTION_BUTTONS.scrollUp.data)
    .text(lockLabel, 'action:scroll-lock')
    .text(scrollDownLabel, ACTION_BUTTONS.scrollDown.data)
    .row()
    .text(ACTION_BUTTONS.clearInput.label, ACTION_BUTTONS.clearInput.data)
    .text(ACTION_BUTTONS.clear.label, ACTION_BUTTONS.clear.data)
    .text(enterLabel, ACTION_BUTTONS.enter.data)
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
 * Send keystrokes to a session in small timed batches.
 * Each batch writes `batchSize` copies of `key`, then waits `delayMs` before the next batch.
 * Returns a Promise that resolves when all batches have been sent.
 */
function sendChunkedKeys(
  sessionManager: Pick<SessionManager, 'writeToSession'>,
  sessionName: string,
  key: string,
  count: number,
  batchSize: number,
  delayMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let sent = 0;
    const sendBatch = (): void => {
      if (sent >= count) { resolve(); return; }
      const remaining = count - sent;
      const thisBatch = Math.min(batchSize, remaining);
      sessionManager.writeToSession(sessionName, key.repeat(thisBatch));
      sent += thisBatch;
      if (sent >= count) { resolve(); return; }
      setTimeout(sendBatch, delayMs);
    };
    sendBatch();
  });
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
  setHubView?: (view: 'sessions' | 'automationHub' | 'automationDetails' | 'cli') => Promise<void>,
  automationHub?: { handleCallback(data: string): Promise<string>; render(opts?: { forceNew?: boolean }): Promise<void> },
  settingsStore?: SettingsStore,
  updateCliScrollState?: (locked: boolean) => void,
): void {
  // Enter confirmation: double-press state
  let enterPendingConfirm = false;
  let enterConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  // Delete button -- removes the bot message it's attached to (no session required)
  bot.callbackQuery('action:delete', async (ctx) => {
    try {
      await ctx.deleteMessage();
    } catch {
      // Message may already be deleted
    }
    await safeAnswer(ctx);
  });

  // Scroll lock toggle -- dedicated handler outside the ACTION_BUTTONS loop
  bot.callbackQuery('action:scroll-lock', async (ctx) => {
    if (!scrollHandler) { await safeAnswer(ctx); return; }
    scrollHandler.toggleLock();
    updateCliScrollState?.(scrollHandler.scrollLocked);
    if (refreshHub) {
      await refreshHub();
    } else {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: buildCLIKeyboard(scrollHandler.scrollLocked, settingsStore?.get('enter_confirmation') ?? false) });
      } catch { /* message may not be editable */ }
    }
    await safeAnswer(ctx);
  });

  // Action buttons -- resolve session dynamically
  for (const action of Object.values(ACTION_BUTTONS)) {
    bot.callbackQuery(action.data, async (ctx) => {
      const sessionName = getActiveSession();
      if (sessionName === null) {
        await safeAnswer(ctx, { text: 'No active session' });
        return;
      }

      // Scroll buttons: handled by ScreenCapture, not PTY
      if (scrollHandler && (action.data === 'action:scroll-up' || action.data === 'action:scroll-down')) {
        if (action.data === 'action:scroll-up') {
          scrollHandler.scrollUp();
          updateCliScrollState?.(scrollHandler.scrollLocked);
        } else {
          scrollHandler.scrollDown();
          updateCliScrollState?.(scrollHandler.scrollLocked);
        }
        if (refreshHub) {
          await refreshHub();
        } else {
          // Fallback: edit standalone message keyboard (legacy path)
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: buildCLIKeyboard(scrollHandler.scrollLocked, settingsStore?.get('enter_confirmation') ?? false) });
          } catch { /* message may not be editable */ }
        }
        await safeAnswer(ctx);
        return;
      }

      // Clear input: send right-arrows (move cursor to end) + backspaces (delete all)
      // Sent in small timed batches so the Ink TUI can process each batch before the next arrives.
      if (action.data === 'action:clear-input') {
        sendChunkedKeys(sessionManager, sessionName, '\x1b[C', 200, 10, 15).then(() =>
          sendChunkedKeys(sessionManager, sessionName, '\x7f', 200, 10, 15)
        );
        await safeAnswer(ctx);
        return;
      }

      // Enter confirmation: double-press required when setting is ON
      if (action.data === 'action:enter' && settingsStore?.get('enter_confirmation')) {
        if (enterPendingConfirm) {
          // Second press within window -- send the signal
          enterPendingConfirm = false;
          if (enterConfirmTimer) { clearTimeout(enterConfirmTimer); enterConfirmTimer = null; }
          sessionManager.writeToSession(sessionName, '\r');
        } else {
          // First press -- set pending, start 7s timeout
          enterPendingConfirm = true;
          enterConfirmTimer = setTimeout(() => {
            enterPendingConfirm = false;
            enterConfirmTimer = null;
          }, 7000);
          await safeAnswer(ctx, { text: 'Press again within 7s to confirm' });
          return;
        }
        await safeAnswer(ctx);
        return;
      }

      sessionManager.writeToSession(sessionName, action.input);
      await safeAnswer(ctx);
    });
  }

  // Hub: switch session
  bot.callbackQuery(/^hub:switch:(.+)$/, async (ctx) => {
    const name = ctx.match![1];
    router.switchTo(name);
    await safeAnswer(ctx, { text: `Switched to ${name}` });
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
      // Local session: stop PTY and remove from router immediately.
      // router.remove() is idempotent, so the subsequent session:exit bus handler
      // in index.ts calling router.remove(name) again is safe.
      try {
        await sessionManager.stop(name);
      } catch {
        // Session may have already exited
      }
      router.remove(name);
    }
    await safeAnswer(ctx, { text: `Disconnected ${name}` });

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
      await safeAnswer(ctx);
    });
  }

  // Hub: toggle advanced view
  if (toggleAdvanced) {
    bot.callbackQuery('hub:advanced', async (ctx) => {
      await toggleAdvanced();
      await safeAnswer(ctx);
    });
  }

  // Hub: 3-state automation view navigation
  if (setHubView) {
    bot.callbackQuery('hub:automations', async (ctx) => {
      await setHubView('automationHub');
      await safeAnswer(ctx);
    });

    bot.callbackQuery('hub:auto-details', async (ctx) => {
      await setHubView('automationDetails');
      await safeAnswer(ctx);
    });

    bot.callbackQuery('hub:auto-back', async (ctx) => {
      await setHubView('sessions');
      await safeAnswer(ctx);
    });

    bot.callbackQuery('hub:cli-back', async (ctx) => {
      await setHubView('sessions');
      await safeAnswer(ctx);
    });
  }

  // Automation hub callbacks
  if (automationHub) {
    bot.callbackQuery(/^auto:/, async (ctx) => {
      const data = ctx.callbackQuery.data;
      const text = await automationHub.handleCallback(data);
      await safeAnswer(ctx, { text });
    });
  }

  // Catch-all for unknown callbacks -- prevent stuck loading animation
  bot.on('callback_query:data', async (ctx) => {
    await safeAnswer(ctx);
  });
}
