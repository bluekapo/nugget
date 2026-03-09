import type { SessionManager } from '../session/manager.js';
import type { HubStore } from '../db/hub-store.js';
import type { AutomationHubRenderer } from './automation-hub.js';
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
  private automationHub: AutomationHubRenderer | null = null;

  /** Sequential promise chain to serialize render() calls and prevent duplicate sendMessage. */
  private renderQueue: Promise<void> = Promise.resolve();

  /** Set the automation hub reference (set after construction due to init ordering). */
  setAutomationHub(hub: AutomationHubRenderer): void {
    this.automationHub = hub;
  }

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
   *
   *  Serialized via renderQueue to prevent duplicate sendMessage calls when
   *  multiple render() calls fire before the first sendMessage resolves.
   */
  async render(opts?: { forceNew?: boolean }): Promise<void> {
    const task = this.renderQueue.then(async () => {
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
      const text = buildText(sessions, activeSession, this.advancedMode, this.execStateMap, this.automationHub);
      const keyboard = buildKeyboard(sessions, activeSession, this.advancedMode, this.automationHub);

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
            // Message was deleted -- reset and re-send on next queued render
            this.hubMessageId = null;
            return;
          }
          logError('Hub editMessageText failed:', err);
        }
      }
    });
    this.renderQueue = task.catch((err) => {
      logError('Hub render queue error:', err);
    });
    return task;
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
  automationHub?: AutomationHubRenderer | null,
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

  const activeAuto = automationHub?.activeAutomationInfo ?? null;

  const lines = sessions.map((s) => {
    const isViewing = s.name === activeSession;
    const prefix = isViewing ? '> ' : '   ';
    const viewState = isViewing ? 'viewing' : 'hidden';

    // Determine emoji status indicator
    let emoji: string;
    if (activeAuto && activeAuto.workerSession === s.name) {
      // Worker in active automation -- robot + engine state abbreviation
      emoji = `\uD83E\uDD16 ${activeAuto.engine.state}`;
    } else if (activeAuto && activeAuto.orchestratorSession === s.name) {
      // Orchestrator in active automation
      emoji = '\uD83C\uDFAF';
    } else if (s.status === 'remote') {
      emoji = '\uD83C\uDF10';
    } else if (s.status === 'stopped') {
      emoji = '\uD83D\uDD34';
    } else {
      // Running session -- check exec state
      const execState = execStateMap.get(s.name) ?? 'idle';
      emoji = execState === 'busy' ? '\uD83D\uDFE0' : '\uD83D\uDFE2';
    }

    let line = `${prefix}${emoji} <b>${s.name}</b> -- ${viewState}`;
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

  let result = `${header}\n\n${lines.join('\n')}`;

  // Append automation status section if applicable
  if (activeAuto) {
    const autoLines = [
      '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
      `\uD83E\uDD16 Automation: ${activeAuto.engine.state} | Cycles: ${activeAuto.cycleCount}`,
      `Worker: ${activeAuto.workerSession} \u2192 Orch: ${activeAuto.orchestratorSession}`,
      `Task: ${activeAuto.taskDescription}`,
    ];
    if (activeAuto.lastAction) {
      autoLines.push(`Last: ${activeAuto.lastAction}`);
    }
    result += '\n\n' + autoLines.join('\n');
  } else if (automationHub?.pendingCreationInfo) {
    const pending = automationHub.pendingCreationInfo;
    const stepLabels: Record<string, string> = {
      'select-worker': 'Select worker session',
      'select-orchestrator': `Worker: ${pending.workerSession ?? '?'} \u2014 Select orchestrator`,
      'enter-task': `Worker: ${pending.workerSession ?? '?'} \u2192 Orch: ${pending.orchestratorSession ?? '?'} \u2014 Enter task`,
    };
    result += '\n\n' + [
      '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
      `\uD83E\uDD16 Setup: ${stepLabels[pending.step] ?? pending.step}`,
    ].join('\n');
  }

  return result;
}

/** Build inline keyboard with switch/disconnect buttons per session. */
function buildKeyboard(
  sessions: Array<{ name: string; status: string }>,
  activeSession: string | null,
  advanced = false,
  automationHub?: AutomationHubRenderer | null,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  const activeAuto = automationHub?.activeAutomationInfo ?? null;
  const pendingCreation = automationHub?.pendingCreationInfo ?? null;

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
    { text: advanced ? '\uD83D\uDCCB Simple' : '\uD83D\uDCCA Details', callback_data: 'hub:advanced' },
    { text: '\uD83D\uDD04 Refresh', callback_data: 'hub:refresh' },
  ]);

  // Automation control rows
  if (activeAuto) {
    const engineState = activeAuto.engine.state;
    if (engineState === 'paused') {
      keyboard.push([
        { text: '\u25B6\uFE0F Resume', callback_data: 'auto:resume' },
        { text: '\uD83D\uDED1 Stop', callback_data: 'auto:stop' },
      ]);
    } else {
      keyboard.push([
        { text: '\u23F8 Pause', callback_data: 'auto:pause' },
        { text: '\uD83D\uDED1 Stop', callback_data: 'auto:stop' },
      ]);
    }
  } else if (pendingCreation) {
    // Show creation flow buttons
    if (pendingCreation.step === 'select-worker') {
      for (const s of sessions) {
        keyboard.push([{ text: `\uD83D\uDD27 ${s.name}`, callback_data: `auto:w:${s.name}` }]);
      }
      keyboard.push([{ text: '\u274C Cancel', callback_data: 'auto:cancel' }]);
    } else if (pendingCreation.step === 'select-orchestrator') {
      for (const s of sessions) {
        if (s.name !== pendingCreation.workerSession) {
          keyboard.push([{ text: `\uD83C\uDFAF ${s.name}`, callback_data: `auto:o:${s.name}` }]);
        }
      }
      keyboard.push([{ text: '\u274C Cancel', callback_data: 'auto:cancel' }]);
    } else if (pendingCreation.step === 'enter-task') {
      keyboard.push([{ text: '\u274C Cancel', callback_data: 'auto:cancel' }]);
    }
  } else if (automationHub) {
    // Idle: show Automate button
    keyboard.push([{ text: '\uD83E\uDD16 Automate', callback_data: 'auto:new' }]);
  }

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
