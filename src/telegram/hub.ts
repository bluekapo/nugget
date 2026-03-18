import type { SessionManager } from '../session/manager.js';
import type { HubStore } from '../db/hub-store.js';
import type { AutomationHubRenderer } from './automation-hub.js';
import type { RateLimiter } from './rate-limiter.js';
import { engineStateLabel } from '../automation/engine.js';
import { logDebug, logInfo, logError } from '../logging/logger.js';
import { ACTION_BUTTONS } from './keyboard.js';
import { wrapPre } from '../output/html.js';

/** The four states the hub view can be in. */
export type HubViewState = 'sessions' | 'automationHub' | 'automationDetails' | 'cli';

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
  private hubViewState: HubViewState = 'sessions';
  private execStateMap: Map<string, 'busy' | 'idle'> = new Map();
  private automationHub: AutomationHubRenderer | null = null;

  /** CLI view state */
  private cliSessionName: string | null = null;
  private cliScreenText = '';
  private cliScrollLocked = true;
  private cliEnterConfirmation = false;

  /** Sequential promise chain to serialize render() calls and prevent duplicate sendMessage. */
  private renderQueue: Promise<void> = Promise.resolve();

  /** Timer handle for debounced render. */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set the automation hub reference (set after construction due to init ordering). */
  setAutomationHub(hub: AutomationHubRenderer): void {
    this.automationHub = hub;
  }

  /** Update the execution state for a session (busy = processing, idle = waiting for input). */
  setExecState(sessionName: string, state: 'busy' | 'idle'): void {
    this.execStateMap.set(sessionName, state);
  }

  /** Remove exec state for a session (call on session exit to clean up). */
  clearExecState(sessionName: string): void {
    this.execStateMap.delete(sessionName);
  }

  /** Store CLI screen content for rendering. Does NOT trigger render (caller is responsible). */
  setCliContent(sessionName: string, screenText: string): void {
    this.cliSessionName = sessionName;
    this.cliScreenText = screenText;
  }

  /** Update CLI keyboard scroll/enter state. */
  setCliScrollState(locked: boolean, enterConfirmation: boolean): void {
    this.cliScrollLocked = locked;
    this.cliEnterConfirmation = enterConfirmation;
  }

  /** Get current CLI content state. */
  getCliContent(): { sessionName: string | null; screenText: string } {
    return { sessionName: this.cliSessionName, screenText: this.cliScreenText };
  }

  /** Debounced render -- coalesces rapid render requests into one. Use for exec-state changes.
   *  Always passes mandatory=false since debounced renders are deferrable.
   */
  debouncedRender(delayMs = 500): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.render({ mandatory: false });
    }, delayMs);
  }

  /** Toggle between normal and advanced view. */
  toggleAdvanced(): void {
    this.advancedMode = !this.advancedMode;
  }

  /** Whether the hub is currently in advanced view mode. */
  get isAdvanced(): boolean {
    return this.advancedMode;
  }

  /** Set the hub view to one of the three navigation states. */
  setHubView(view: HubViewState): void {
    logDebug(`[hub] setHubView('${view}')`);
    this.hubViewState = view;
  }

  /** Current hub view state (sessions, automationHub, or automationDetails). */
  get hubView(): HubViewState {
    return this.hubViewState;
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
    private readonly isRemote?: (name: string) => boolean,
    private readonly store?: HubStore,
    private readonly rateLimiter?: RateLimiter,
    private readonly getRemoteMetadata?: (name: string) => { pid?: number | null; createdAt?: string } | undefined,
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
   *  When mandatory is false, the render may be silently dropped if the rate limiter
   *  says we've sent too recently (deferrable send). Default is true (mandatory).
   *
   *  Serialized via renderQueue to prevent duplicate sendMessage calls when
   *  multiple render() calls fire before the first sendMessage resolves.
   */
  async render(opts?: { forceNew?: boolean; mandatory?: boolean }): Promise<void> {
    const task = this.renderQueue.then(async () => {
      // Rate limiter gate: deferrable sends can be silently dropped
      if (this.rateLimiter && !this.rateLimiter.canSend(opts?.mandatory ?? true)) {
        return;
      }

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
        } else if (this.isRemote?.(name)) {
          // Truly remote session -- PTY lives in another process
          const meta = this.getRemoteMetadata?.(name);
          sessions.push({ name, status: 'remote', pid: meta?.pid, createdAt: meta?.createdAt });
        } else {
          // Local session missing from DB (race condition / cleanup mismatch)
          sessions.push({ name, status: 'running' });
        }
      }

      const activeSession = this.getActiveSession();
      const text = buildText(sessions, activeSession, this.advancedMode, this.execStateMap, this.automationHub, this.hubViewState, this.cliSessionName, this.cliScreenText);
      const keyboard = buildKeyboard(sessions, activeSession, this.advancedMode, this.automationHub, this.hubViewState, this.cliScrollLocked, this.cliEnterConfirmation);

      if (this.hubMessageId === null) {
        // Send new message
        try {
          const result = await this.api.sendMessage(this.chatId, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
          this.hubMessageId = result.message_id;
          if (this.store) this.store.save(result.message_id);
          this.rateLimiter?.recordSend();
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
          this.rateLimiter?.recordSend();
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
    logDebug(`[hub] delete() hubMessageId=${this.hubMessageId}`);
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
  hubView: HubViewState = 'sessions',
  cliSessionName: string | null = null,
  cliScreenText = '',
): string {
  const activeAuto = automationHub?.activeAutomationInfo ?? null;
  const autoCount = automationHub?.activeAutomationCount ?? 0;
  const allAutos = automationHub?.allAutomations;
  const pendingCreation = automationHub?.pendingCreationInfo ?? null;

  // Pending creation flow still replaces the hub (user is actively configuring)
  if (pendingCreation) {
    const stepTexts: Record<string, string[]> = {
      'select-worker': [
        '<b>Automation Hub</b>',
        '',
        'Select worker session:',
      ],
      'select-orchestrator': [
        '<b>Automation Hub</b>',
        '',
        `Worker: <b>${pendingCreation.workerSession}</b>`,
        'Select orchestrator session:',
      ],
      'enter-task': [
        '<b>Automation Hub</b>',
        '',
        `Worker: <b>${pendingCreation.workerSession}</b>`,
        `Orchestrator: <b>${pendingCreation.orchestratorSession}</b>`,
        '',
        'Type your task description below.',
      ],
      'confirm-task': [
        '<b>Automation Hub</b>',
        '',
        `Worker: <b>${pendingCreation.workerSession}</b>`,
        `Orchestrator: <b>${pendingCreation.orchestratorSession}</b>`,
        '',
        'Task:',
        `<i>${pendingCreation.taskDescription}</i>`,
        '',
        'Review and confirm to start.',
      ],
    };
    return (stepTexts[pendingCreation.step] ?? ['<b>Automation Hub</b>']).join('\n');
  }

  // CLI view: terminal screen content in a pre block
  if (hubView === 'cli') {
    if (cliSessionName) {
      return wrapPre(cliScreenText, `CLI of ${cliSessionName}`);
    }
    return '<b>CLI View</b>\n\nNo session selected.';
  }

  // Automation details view: full detail with worker/orch/task/status/cycles/lastAction
  if (hubView === 'automationDetails') {
    if (activeAuto) {
      const lines = [
        '<b>Automation Details</b>',
        '',
        `Worker: <b>${activeAuto.workerSession}</b> \u2192 Orchestrator: <b>${activeAuto.orchestratorSession}</b>`,
        `Task: ${activeAuto.taskDescription}`,
        '',
        `Status: ${engineStateLabel(activeAuto.engine.state)} | Cycles: ${activeAuto.cycleCount}`,
      ];
      if (activeAuto.lastAction) {
        lines.push(`Last: ${activeAuto.lastAction}`);
      }
      return lines.join('\n');
    }
    return ['<b>Automation Details</b>', '', 'No automation running.'].join('\n');
  }

  // Automation hub view: multi-automation list or single-automation summary
  if (hubView === 'automationHub') {
    // Multi-automation list: show numbered list with per-automation status
    if (allAutos && allAutos.size > 1) {
      const lines = [
        '<b>Automation Hub</b>',
        '',
      ];
      for (const [id, auto] of allAutos) {
        lines.push(`${id}. ${engineStateLabel(auto.engine.state)} | ${auto.workerSession} \u2192 ${auto.orchestratorSession} | Cycles: ${auto.cycleCount}`);
      }
      return lines.join('\n');
    }
    // Single automation: backward-compatible summary with truncated task
    if (activeAuto) {
      const truncatedTask = activeAuto.taskDescription.length > 80
        ? activeAuto.taskDescription.slice(0, 80) + '...'
        : activeAuto.taskDescription;
      const lines = [
        '<b>Automation Hub</b>',
        '',
        `State: ${engineStateLabel(activeAuto.engine.state)} | Cycles: ${activeAuto.cycleCount}`,
        `Task: ${truncatedTask}`,
        '',
        'Tap View Details for full status and controls.',
      ];
      return lines.join('\n');
    }
    return ['<b>Automation Hub</b>', '', 'No automation running.', 'Tap New Automation to start.', '', '<i>Cycle limit configurable via /settings</i>'].join('\n');
  }

  if (sessions.length === 0) {
    const emptyLines = [
      '<b>Sessions Hub</b>',
      '',
      'No sessions connected.',
      'Start a session with: npm run dev -- session-name',
    ];
    if (autoCount > 0) {
      emptyLines.push('', `\uD83E\uDD16 ${autoCount} automation${autoCount !== 1 ? 's' : ''} in progress`);
    }
    return emptyLines.join('\n');
  }

  const header = `<b>Sessions Hub</b>  (${sessions.length} session${sessions.length !== 1 ? 's' : ''})`;

  const lines = sessions.map((s) => {
    const isViewing = s.name === activeSession;
    const prefix = isViewing ? '> ' : '   ';
    const viewState = isViewing ? 'viewing' : 'hidden';

    // Determine emoji status indicator and execution state text
    let emoji: string;
    let execState: string;
    if (s.status === 'remote') {
      emoji = '\uD83C\uDF10';
      execState = execStateMap.get(s.name) ?? 'idle';
    } else if (s.status === 'stopped') {
      emoji = '\uD83D\uDD34';
      execState = s.status;
    } else if (s.status === 'running') {
      execState = execStateMap.get(s.name) ?? 'idle';
      emoji = execState === 'busy' ? '\uD83D\uDFE0' : '\uD83D\uDFE2';
    } else {
      // Non-running status (starting, etc)
      emoji = '\u26AA';
      execState = s.status;
    }

    let line = `${prefix}${emoji} <b>${s.name}</b> -- ${viewState} \u00B7 ${execState}`;

    // Append role indicator if session is part of any active automation
    if (allAutos) {
      for (const auto of allAutos.values()) {
        if (s.name === auto.workerSession) {
          const pauseTag = auto.engine.state === 'paused' ? ' \u23F8' : '';
          line += ` [worker${pauseTag}]`;
          break;
        } else if (s.name === auto.orchestratorSession) {
          const pauseTag = auto.engine.state === 'paused' ? ' \u23F8' : '';
          line += ` [orch${pauseTag}]`;
          break;
        }
      }
    }

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
  if (autoCount > 0) {
    result += `\n\n\uD83E\uDD16 ${autoCount} automation${autoCount !== 1 ? 's' : ''} in progress`;
  }
  return result;
}

/** Build inline keyboard with switch/disconnect buttons per session. */
function buildKeyboard(
  sessions: Array<{ name: string; status: string }>,
  activeSession: string | null,
  advanced = false,
  automationHub?: AutomationHubRenderer | null,
  hubView: HubViewState = 'sessions',
  cliScrollLocked = true,
  cliEnterConfirmation = false,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string; style?: string }>> } {
  const keyboard: Array<Array<{ text: string; callback_data: string; style?: string }>> = [];

  const activeAuto = automationHub?.activeAutomationInfo ?? null;
  const autoCount = automationHub?.activeAutomationCount ?? 0;
  const pendingCreation = automationHub?.pendingCreationInfo ?? null;

  // Pending creation flow still replaces the keyboard (user is actively configuring)
  if (pendingCreation) {
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
    } else if (pendingCreation.step === 'confirm-task') {
      keyboard.push([{ text: '\u2705 Confirm', callback_data: 'auto:confirm' }]);
      keyboard.push([
        { text: '\u270F\uFE0F Edit', callback_data: 'auto:edit' },
        { text: '\u274C Cancel', callback_data: 'auto:cancel' },
      ]);
    }
    return { inline_keyboard: keyboard };
  }

  // CLI view: replicate CLI keyboard layout with Back to Sessions
  if (hubView === 'cli') {
    const lockLabel = cliScrollLocked ? '\uD83D\uDD34\uD83D\uDD12' : '\uD83D\uDFE2\uD83D\uDD13';
    const scrollUpLabel = cliScrollLocked ? '\uD83D\uDD12 \u2B06 Scroll Up' : '\u2B06 Scroll Up';
    const scrollDownLabel = cliScrollLocked ? '\uD83D\uDD12 \u2B07 Scroll Down' : '\u2B07 Scroll Down';
    const enterLabel = cliEnterConfirmation ? '\uD83D\uDEE1 \u21A9 Enter' : ACTION_BUTTONS.enter.label;

    keyboard.push(
      // Row 1: Scroll Up / Lock / Scroll Down
      [
        { text: scrollUpLabel, callback_data: ACTION_BUTTONS.scrollUp.data },
        { text: lockLabel, callback_data: 'action:scroll-lock' },
        { text: scrollDownLabel, callback_data: ACTION_BUTTONS.scrollDown.data },
      ],
      // Row 2: Clear-input / /clear / Enter
      [
        { text: ACTION_BUTTONS.clearInput.label, callback_data: ACTION_BUTTONS.clearInput.data },
        { text: ACTION_BUTTONS.clear.label, callback_data: ACTION_BUTTONS.clear.data },
        { text: enterLabel, callback_data: ACTION_BUTTONS.enter.data },
      ],
      // Row 3: Esc / Up / Bksp
      [
        { text: ACTION_BUTTONS.escape.label, callback_data: ACTION_BUTTONS.escape.data },
        { text: ACTION_BUTTONS.arrowUp.label, callback_data: ACTION_BUTTONS.arrowUp.data },
        { text: ACTION_BUTTONS.backspace.label, callback_data: ACTION_BUTTONS.backspace.data },
      ],
      // Row 4: Left / Down / Right
      [
        { text: ACTION_BUTTONS.arrowLeft.label, callback_data: ACTION_BUTTONS.arrowLeft.data },
        { text: ACTION_BUTTONS.arrowDown.label, callback_data: ACTION_BUTTONS.arrowDown.data },
        { text: ACTION_BUTTONS.arrowRight.label, callback_data: ACTION_BUTTONS.arrowRight.data },
      ],
      // Row 5: Back to Sessions
      [
        { text: '\u2190 Back to Sessions', callback_data: 'hub:cli-back' },
      ],
    );
    return { inline_keyboard: keyboard };
  }

  // Automation details view: show automation control buttons (pause/stop, refresh, back)
  if (hubView === 'automationDetails') {
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
      keyboard.push([{ text: '\uD83D\uDD04 Refresh', callback_data: 'auto:refresh' }]);
    }
    keyboard.push([{ text: '\u2190 Back to Sessions', callback_data: 'hub:auto-back' }]);
    return { inline_keyboard: keyboard };
  }

  // Automation hub view: multi-automation detail buttons or single View Details + Back
  if (hubView === 'automationHub') {
    const allAutos = automationHub?.allAutomations;
    if (allAutos && allAutos.size > 1) {
      // Per-automation detail buttons
      for (const [id, auto] of allAutos) {
        const stateEmoji = auto.engine.state === 'paused' ? '\u23F8' : '\uD83D\uDD0D';
        keyboard.push([{ text: `${stateEmoji} ${auto.workerSession} \u2192 ${auto.orchestratorSession}`, callback_data: `auto:details:${id}` }]);
      }
      keyboard.push([{ text: '\uD83E\uDD16 New Automation', callback_data: 'auto:new' }]);
      keyboard.push([{ text: '\u2190 Back to Sessions', callback_data: 'hub:auto-back' }]);
    } else {
      if (activeAuto) {
        keyboard.push([{ text: '\uD83D\uDD0D View Details', callback_data: 'hub:auto-details' }]);
      }
      keyboard.push([{ text: '\u2190 Back to Sessions', callback_data: 'hub:auto-back' }]);
    }
    return { inline_keyboard: keyboard };
  }

  // Session rows (only when no automation is active/pending)
  for (const s of sessions) {
    const row: Array<{ text: string; callback_data: string; style?: string }> = [];

    // Switch button only for non-active sessions
    if (s.name !== activeSession) {
      row.push({
        text: `\uD83D\uDD04 ${s.name}`,
        callback_data: `hub:switch:${s.name}`,
      });
    }

    // For the active session: Resume (left) + Kill (right) in one row
    // For other sessions: Switch (has name) + Kill (skull only)
    const isActive = s.name === activeSession;
    if (isActive) {
      row.push({
        text: `▶️ ${s.name}`,
        callback_data: 'hub:cli-resume',
      });
    }
    row.push({
      text: isActive ? '💀' : `💀`,
      callback_data: `hub:disconnect:${s.name}`,
      style: 'danger',
    });

    keyboard.push(row);
  }

  // Bottom row: Details/Simple toggle + Refresh
  keyboard.push([
    { text: advanced ? '\uD83D\uDCCB Simple' : '\uD83D\uDCCA Details', callback_data: 'hub:advanced' },
    { text: '\uD83D\uDD04 Refresh', callback_data: 'hub:refresh' },
  ]);

  // Automation button: show status link when active, or new automation button when idle
  if (autoCount > 0) {
    keyboard.push([{ text: `\uD83E\uDD16 Automations (${autoCount})`, callback_data: 'hub:automations' }]);
  } else if (automationHub) {
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
