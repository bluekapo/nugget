import type { SessionManager } from '../session/manager.js';
import type { HubStore } from '../db/hub-store.js';
import { logError } from '../logging/logger.js';

/**
 * Renders and manages the central "Sessions Hub" message in Telegram.
 *
 * - Shows all active sessions with status indicators (green/white circle)
 * - Provides inline switch and disconnect buttons per session
 * - Edits the hub message in-place on re-render (no message spam)
 */
export class HubRenderer {
  private hubMessageId: number | null = null;
  private advancedMode = false;
  private execStateMap: Map<string, 'busy' | 'idle'> = new Map();

  /** Update the execution state for a session (busy = processing, idle = waiting for input). */
  setExecState(sessionName: string, state: 'busy' | 'idle'): void {
    this.execStateMap.set(sessionName, state);
  }

  /** Toggle between normal and advanced view. */
  toggleAdvanced(): void {
    this.advancedMode = !this.advancedMode;
  }

  /** Whether the hub is currently in advanced view mode. */
  get isAdvanced(): boolean {
    return this.advancedMode;
  }

  constructor(
    private readonly api: {
      sendMessage(chatId: number, text: string, opts?: unknown): Promise<{ message_id: number }>;
      editMessageText(chatId: number, messageId: number, text: string, opts?: unknown): Promise<unknown>;
      deleteMessage(chatId: number, messageId: number): Promise<unknown>;
    },
    private readonly chatId: number,
    private readonly sessionManager: Pick<SessionManager, 'getActive'>,
    private readonly getActiveSession: () => string | null,
    private readonly getAllSessionNames?: () => string[],
    private readonly store?: HubStore,
  ) {
    // On construction, load persisted hub message ID and attempt to delete it.
    // This handles the case where a secondary promotes and needs to clean up the old hub.
    if (store) {
      const oldId = store.load();
      if (oldId !== null) {
        this.api.deleteMessage(this.chatId, oldId).catch(() => {});
        store.clear();
      }
    }
  }

  /** Render or re-render the hub message. Sends new or edits existing.
   *  When forceNew is true, deletes the old hub message and sends a fresh one
   *  at the bottom of the chat (used by /hub command to ensure visibility).
   */
  async render(opts?: { forceNew?: boolean }): Promise<void> {
    if (opts?.forceNew && this.hubMessageId !== null) {
      try {
        await this.api.deleteMessage(this.chatId, this.hubMessageId);
      } catch {
        // Message may already be gone -- ignore
      }
      this.hubMessageId = null;
      if (this.store) this.store.clear();
    }

    // Merge local DB sessions with router's full list (includes remote sessions)
    const dbSessions = this.sessionManager.getActive();
    const allNames = this.getAllSessionNames?.() ?? dbSessions.map(s => s.name);

    // Build session list: use DB info when available, synthesize for remote-only sessions
    const sessions: Array<{ name: string; status: string; pid?: number | null; createdAt?: string }> = [];
    const dbMap = new Map(dbSessions.map(s => [s.name, s]));

    for (const name of allNames) {
      const dbEntry = dbMap.get(name);
      if (dbEntry) {
        sessions.push({ name: dbEntry.name, status: dbEntry.status, pid: (dbEntry as any).pid, createdAt: (dbEntry as any).createdAt });
      } else {
        // Remote session -- not in local DB
        sessions.push({ name, status: 'remote' });
      }
    }

    const activeSession = this.getActiveSession();
    const text = buildText(sessions, activeSession, this.advancedMode, this.execStateMap);
    const keyboard = buildKeyboard(sessions, activeSession, this.advancedMode);

    if (this.hubMessageId === null) {
      // Send new message
      try {
        const result = await this.api.sendMessage(this.chatId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        this.hubMessageId = result.message_id;
        if (this.store) this.store.save(result.message_id);
      } catch (err) {
        logError('Hub sendMessage failed:', err);
      }
    } else {
      // Edit existing message
      try {
        await this.api.editMessageText(this.chatId, this.hubMessageId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch (err: unknown) {
        if (isNotModifiedError(err)) {
          // Suppress -- content identical
          return;
        }
        if (isMessageNotFoundError(err)) {
          // Message was deleted -- reset and re-send
          this.hubMessageId = null;
          await this.render();
          return;
        }
        logError('Hub editMessageText failed:', err);
      }
    }
  }

  /** Delete the hub message entirely and clear persisted state. */
  async delete(): Promise<void> {
    if (this.hubMessageId === null) return;
    try {
      await this.api.deleteMessage(this.chatId, this.hubMessageId);
    } catch {
      // Message may already be deleted
    }
    this.hubMessageId = null;
    if (this.store) this.store.clear();
  }
}

/** Build HTML text for the hub message. */
function buildText(
  sessions: Array<{ name: string; status: string; pid?: number | null; createdAt?: string }>,
  activeSession: string | null,
  advanced = false,
  execStateMap: Map<string, 'busy' | 'idle'> = new Map(),
): string {
  if (sessions.length === 0) {
    return [
      '<b>Sessions Hub</b>',
      '',
      'No sessions connected.',
      'Start a session with: npm run dev -- session-name',
    ].join('\n');
  }

  const header = `<b>Sessions Hub</b>  (${sessions.length} session${sessions.length !== 1 ? 's' : ''})`;

  const lines = sessions.map((s) => {
    const isViewing = s.name === activeSession;
    const prefix = isViewing ? '> ' : '   ';
    const viewState = isViewing ? 'viewing' : 'hidden';
    const execState = (s.status === 'running' || s.status === 'remote')
      ? (execStateMap.get(s.name) ?? 'idle')
      : s.status;
    let line = `${prefix}<b>${s.name}</b> -- ${viewState} \u00B7 ${execState}`;
    if (advanced) {
      const pid = s.pid != null ? String(s.pid) : '?';
      let since = '?';
      if (s.createdAt) {
        try {
          const d = new Date(s.createdAt.endsWith('Z') ? s.createdAt : s.createdAt + 'Z');
          since = d.toLocaleString('en-GB', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit',
          });
        } catch {
          since = s.createdAt.replace('T', ' ').slice(0, 16);
        }
      }
      line += `\n      PID: ${pid} | ${since}`;
    }
    return line;
  });

  return `${header}\n\n${lines.join('\n')}`;
}

/** Build inline keyboard with switch/disconnect buttons per session. */
function buildKeyboard(
  sessions: Array<{ name: string; status: string }>,
  activeSession: string | null,
  advanced = false,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const s of sessions) {
    const row: Array<{ text: string; callback_data: string }> = [];

    // Switch button only for non-active sessions
    if (s.name !== activeSession) {
      row.push({
        text: `\uD83D\uDD04 ${s.name}`,
        callback_data: `hub:switch:${s.name}`,
      });
    }

    // Disconnect button for all sessions
    // Show session name only when there's no switch button (active session),
    // since the switch button already displays the name
    const hasSwitch = s.name !== activeSession;
    row.push({
      text: hasSwitch ? '\uD83D\uDC80' : `\uD83D\uDC80 ${s.name}`,
      callback_data: `hub:disconnect:${s.name}`,
    });

    keyboard.push(row);
  }

  // Bottom row: Details/Simple toggle + Refresh
  keyboard.push([
    { text: advanced ? 'Simple' : 'Details', callback_data: 'hub:advanced' },
    { text: '\uD83D\uDD04 Refresh', callback_data: 'hub:refresh' },
  ]);

  return { inline_keyboard: keyboard };
}

/** Check if an error is Telegram's "message is not modified" response. */
export function isNotModifiedError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.message.includes('not modified')) return true;
    if ('description' in err && typeof (err as Record<string, unknown>).description === 'string') {
      return ((err as Record<string, unknown>).description as string).includes('not modified');
    }
  }
  return false;
}

/** Check if an error is Telegram's "message to edit not found" response. */
export function isMessageNotFoundError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.message.includes('message to edit not found')) return true;
    if ('description' in err && typeof (err as Record<string, unknown>).description === 'string') {
      return ((err as Record<string, unknown>).description as string).includes('message to edit not found');
    }
  }
  return false;
}
