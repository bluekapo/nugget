/**
 * AutomationHubRenderer -- Telegram message manager for the automation lifecycle.
 *
 * Supports multiple concurrent automations via a Map-based data structure.
 * Provides list view (all automations) and detail view (single automation controls).
 *
 * Handles the full automation flow via a single editable hub message:
 * - Creation flow: select worker -> select orchestrator -> enter task description
 * - List view: shows all active automations with "View Details" per-row
 * - Detail view: shows engine state, cycle count, last action, pause/resume/stop
 *
 * Follows the same renderQueue serialization pattern as HubRenderer.
 */
import type { AutomationEngine, EngineConfig } from '../automation/engine.js';
import { engineStateLabel } from '../automation/engine.js';
import type { EventBus } from '../events/bus.js';
import { isNotModifiedError, isMessageNotFoundError } from './hub.js';
import { logError } from '../logging/logger.js';

export interface PendingCreation {
  step: 'select-worker' | 'select-orchestrator' | 'enter-task' | 'confirm-task';
  workerSession?: string;
  orchestratorSession?: string;
  taskDescription?: string;
}

export interface ActiveAutomation {
  engine: AutomationEngine;
  workerSession: string;
  orchestratorSession: string;
  taskDescription: string;
  cycleCount: number;
  lastAction: string | null;
  startTime: number;
  handlers: {
    stateChange: (state: string) => void;
    cycleComplete: (cycleNumber: number, action: string) => void;
    escalation: (reason: string) => void;
    done: (summary: string) => void;
    error: (error: string) => void;
  };
}

export class AutomationHubRenderer {
  private hubMessageId: number | null = null;
  private renderQueue: Promise<void> = Promise.resolve();
  private pendingCreation: PendingCreation | null = null;
  private activeAutomations: Map<number, ActiveAutomation> = new Map();
  private nextAutomationId = 1;
  private detailViewId: number | null = null;

  /** Optional callback invoked when automation state changes and a re-render is needed. */
  onRender: (() => void | Promise<void>) | null = null;

  /** Public getter for the automation currently in detail view (or null if in list view).
   *  Backwards-compatible: hub.ts uses this for automationDetails rendering. */
  get activeAutomationInfo(): ActiveAutomation | null {
    if (this.detailViewId !== null) {
      return this.activeAutomations.get(this.detailViewId) ?? null;
    }
    // When in list view but only one automation exists, still return it
    // for backward compat with hub.ts session role indicators
    if (this.activeAutomations.size === 1) {
      return this.activeAutomations.values().next().value ?? null;
    }
    return null;
  }

  /** Number of active automations. */
  get activeAutomationCount(): number {
    return this.activeAutomations.size;
  }

  /** All active automations (read-only) for hub.ts to render the list. */
  get allAutomations(): ReadonlyMap<number, ActiveAutomation> {
    return this.activeAutomations;
  }

  /** Public getter for the pending creation info (read-only access for hub display). */
  get pendingCreationInfo(): PendingCreation | null {
    return this.pendingCreation;
  }

  constructor(
    private readonly api: {
      sendMessage(chatId: number, text: string, opts?: unknown): Promise<{ message_id: number }>;
      editMessageText(chatId: number, messageId: number, text: string, opts?: unknown): Promise<unknown>;
      deleteMessage(chatId: number, messageId: number): Promise<unknown>;
    },
    private readonly chatId: number,
    private readonly getAllSessions: () => string[],
    private readonly engineFactory: (config: EngineConfig, bus: EventBus) => AutomationEngine,
    private readonly bus: EventBus,
  ) {}

  /**
   * Render or re-render the hub message. Serialized via renderQueue.
   * When forceNew is true, deletes the old message and sends a fresh one.
   */
  async render(opts?: { forceNew?: boolean }): Promise<void> {
    const task = this.renderQueue.then(async () => {
      if (opts?.forceNew && this.hubMessageId !== null) {
        try {
          await this.api.deleteMessage(this.chatId, this.hubMessageId);
        } catch {
          // Message may already be gone
        }
        this.hubMessageId = null;
      }

      const text = this.buildText();
      const keyboard = this.buildKeyboard();

      if (this.hubMessageId === null) {
        try {
          const result = await this.api.sendMessage(this.chatId, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
          this.hubMessageId = result.message_id;
        } catch (err) {
          logError('AutomationHub sendMessage failed:', err);
        }
      } else {
        try {
          await this.api.editMessageText(this.chatId, this.hubMessageId, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } catch (err: unknown) {
          if (isNotModifiedError(err)) return;
          if (isMessageNotFoundError(err)) {
            this.hubMessageId = null;
            return;
          }
          logError('AutomationHub editMessageText failed:', err);
        }
      }
    });
    this.renderQueue = task.catch((err) => {
      logError('AutomationHub render queue error:', err);
    });
    return task;
  }

  /**
   * Route callback_data strings to state transitions.
   * Returns a string suitable for answerCallbackQuery text.
   */
  async handleCallback(data: string): Promise<string> {
    if (data === 'auto:new') {
      this.pendingCreation = { step: 'select-worker' };
      await this.onRender?.();
      return 'Select a worker session';
    }

    if (data === 'auto:cancel') {
      this.pendingCreation = null;
      await this.onRender?.();
      return 'Creation cancelled';
    }

    if (data === 'auto:confirm') {
      if (this.pendingCreation?.step === 'confirm-task' && this.pendingCreation.taskDescription) {
        await this.completeCreation(this.pendingCreation.taskDescription);
        return 'Automation started';
      }
      return '';
    }

    if (data === 'auto:edit') {
      if (this.pendingCreation?.step === 'confirm-task') {
        this.pendingCreation = {
          ...this.pendingCreation,
          step: 'enter-task',
          taskDescription: undefined,
        };
        await this.onRender?.();
        return 'Edit your task description';
      }
      return '';
    }

    if (data.startsWith('auto:w:')) {
      const sessionName = data.slice('auto:w:'.length);
      const sessions = this.getAllSessions();
      if (!sessions.includes(sessionName)) {
        // Stale session -- reset to idle
        this.pendingCreation = null;
        await this.onRender?.();
        return 'Session not found';
      }
      this.pendingCreation = {
        step: 'select-orchestrator',
        workerSession: sessionName,
      };
      await this.onRender?.();
      return 'Select an orchestrator session';
    }

    if (data.startsWith('auto:o:')) {
      const sessionName = data.slice('auto:o:'.length);
      this.pendingCreation = {
        ...this.pendingCreation!,
        step: 'enter-task',
        orchestratorSession: sessionName,
      };
      await this.onRender?.();
      return 'Enter your task description';
    }

    // Detail view: auto:details:N
    if (data.startsWith('auto:details:')) {
      const id = parseInt(data.slice('auto:details:'.length), 10);
      if (this.activeAutomations.has(id)) {
        this.detailViewId = id;
        await this.onRender?.();
        return 'Viewing automation details';
      }
      return '';
    }

    // Back to list view
    if (data === 'auto:back') {
      this.detailViewId = null;
      await this.onRender?.();
      return 'Back to list';
    }

    // Pause/resume/stop operate on the detail-view automation
    if (data === 'auto:pause') {
      const auto = this.getDetailAutomation();
      if (auto) {
        auto.engine.pause();
        await this.onRender?.();
        return 'Automation paused';
      }
      return '';
    }

    if (data === 'auto:resume') {
      const auto = this.getDetailAutomation();
      if (auto) {
        auto.engine.resume();
        await this.onRender?.();
        return 'Automation resumed';
      }
      return '';
    }

    if (data === 'auto:stop') {
      const id = this.detailViewId;
      if (id !== null) {
        const auto = this.activeAutomations.get(id);
        if (auto) {
          this.removeAutomation(id);
          // Return to list or clear detail view
          this.detailViewId = null;
          await this.onRender?.();
          return 'Automation stopped';
        }
      }
      return '';
    }

    if (data === 'auto:refresh') {
      await this.onRender?.();
      return 'Refreshed';
    }

    return '';
  }

  /**
   * Final step of creation flow. Creates engine via factory, subscribes to
   * bus events, starts engine, transitions to active automation state.
   */
  async completeCreation(taskDescription: string): Promise<void> {
    if (!this.pendingCreation || (this.pendingCreation.step !== 'enter-task' && this.pendingCreation.step !== 'confirm-task')) return;
    if (!this.pendingCreation.workerSession || !this.pendingCreation.orchestratorSession) return;

    const config: EngineConfig = {
      workerSession: this.pendingCreation.workerSession,
      orchestratorSession: this.pendingCreation.orchestratorSession,
      taskDescription,
    };

    const engine = this.engineFactory(config, this.bus);
    const id = this.nextAutomationId++;

    // Build per-automation handlers that capture the automation ID
    const handlers = {
      stateChange: (_state: string) => {
        this.onRender?.();
      },
      cycleComplete: (cycleNumber: number, action: string) => {
        const auto = this.activeAutomations.get(id);
        if (auto) {
          auto.cycleCount = cycleNumber;
          auto.lastAction = action;
        }
        this.onRender?.();
      },
      escalation: (reason: string) => {
        this.api.sendMessage(this.chatId, `Automation escalated: ${reason}`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]],
          },
        }).catch(() => {});
        this.onRender?.();
      },
      done: (_summary: string) => {
        // Clean up error handler BEFORE cleanup to prevent race condition
        const auto = this.activeAutomations.get(id);
        if (auto) {
          this.bus.off('automation:error', auto.handlers.error);
        }
        this.api.sendMessage(this.chatId, '\u2705 Automation complete', {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]],
          },
        }).catch(() => {});
        this.activeAutomations.delete(id);
        if (this.detailViewId === id) this.detailViewId = null;
        this.onRender?.();
      },
      error: (error: string) => {
        this.api.sendMessage(this.chatId, `Automation stopped: ${error}`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]],
          },
        }).catch(() => {});
        this.activeAutomations.delete(id);
        if (this.detailViewId === id) this.detailViewId = null;
        this.onRender?.();
      },
    };

    const automation: ActiveAutomation = {
      engine,
      workerSession: config.workerSession,
      orchestratorSession: config.orchestratorSession,
      taskDescription,
      cycleCount: 0,
      lastAction: null,
      startTime: Date.now(),
      handlers,
    };

    this.activeAutomations.set(id, automation);

    // Auto-navigate to detail view for the newly created automation
    this.detailViewId = id;

    // Subscribe per-automation handlers to bus events
    this.bus.on('automation:state-change', handlers.stateChange);
    this.bus.on('automation:cycle-complete', handlers.cycleComplete);
    this.bus.on('automation:escalation', handlers.escalation);
    this.bus.on('automation:done', handlers.done);
    this.bus.on('automation:error', handlers.error);

    this.pendingCreation = null;
    engine.start();
    await this.onRender?.();
  }

  /**
   * Intermediate step: store task description and transition to confirm-task
   * so the user can review before starting the engine.
   */
  async submitTaskForReview(text: string): Promise<void> {
    if (!this.pendingCreation || this.pendingCreation.step !== 'enter-task') return;
    this.pendingCreation = { ...this.pendingCreation, step: 'confirm-task', taskDescription: text };
    await this.onRender?.();
  }

  /** Update cycle count and last action for a specific automation (by detail view). */
  updateCycleInfo(cycleNumber: number, action: string): void {
    // Legacy compatibility: update the detail-view automation or the only automation
    const auto = this.getDetailAutomation() ?? (this.activeAutomations.size === 1 ? this.activeAutomations.values().next().value : null);
    if (!auto) return;
    auto.cycleCount = cycleNumber;
    auto.lastAction = action;
  }

  /** Returns true if the given session is the worker in ANY active automation. */
  isAutomatedSession(sessionName: string): boolean {
    return [...this.activeAutomations.values()].some(a => a.workerSession === sessionName);
  }

  /** Returns true iff currently in the enter-task creation step. */
  isAwaitingTaskInput(): boolean {
    return this.pendingCreation?.step === 'enter-task';
  }

  /** Clean up bus listeners and stop all engines. */
  dispose(): void {
    for (const [id] of this.activeAutomations) {
      this.removeAutomation(id);
    }
    this.activeAutomations.clear();
    this.detailViewId = null;
  }

  /** Get the automation currently viewed in detail, or null. */
  private getDetailAutomation(): ActiveAutomation | null {
    if (this.detailViewId !== null) {
      return this.activeAutomations.get(this.detailViewId) ?? null;
    }
    return null;
  }

  /** Remove an automation: unsubscribe handlers, stop engine, delete from map. */
  private removeAutomation(id: number): void {
    const auto = this.activeAutomations.get(id);
    if (!auto) return;

    this.bus.off('automation:state-change', auto.handlers.stateChange);
    this.bus.off('automation:cycle-complete', auto.handlers.cycleComplete);
    this.bus.off('automation:escalation', auto.handlers.escalation);
    this.bus.off('automation:done', auto.handlers.done);
    this.bus.off('automation:error', auto.handlers.error);

    auto.engine.stop();
    this.activeAutomations.delete(id);
  }

  /** Format relative time from startTime to now. */
  private formatElapsed(startTime: number): string {
    const elapsedMs = Date.now() - startTime;
    const minutes = Math.floor(elapsedMs / 60000);
    if (minutes < 1) return 'just started';
    if (minutes === 1) return '1m ago';
    return `${minutes}m ago`;
  }

  /** Build HTML text based on current state. */
  private buildText(): string {
    // Detail view for a specific automation
    if (this.detailViewId !== null) {
      const a = this.activeAutomations.get(this.detailViewId);
      if (a) {
        const lines = [
          '<b>Automation Hub</b>',
          '',
          `Worker: <b>${a.workerSession}</b> -> Orchestrator: <b>${a.orchestratorSession}</b>`,
          `Task: ${a.taskDescription}`,
          '',
          `Status: ${engineStateLabel(a.engine.state)} | Cycles: ${a.cycleCount}`,
        ];
        if (a.lastAction) {
          lines.push(`Last: ${a.lastAction}`);
        }
        return lines.join('\n');
      }
      // Automation was removed while viewing -- fall through to list/idle
      this.detailViewId = null;
    }

    // List view: multiple automations running
    if (this.activeAutomations.size > 0 && this.detailViewId === null) {
      const lines = [
        '<b>Automation Hub</b>',
        '',
        'Active Automations:',
      ];
      for (const [id, a] of this.activeAutomations) {
        lines.push(`${id}. ${a.workerSession} -> ${a.orchestratorSession} (${this.formatElapsed(a.startTime)})`);
      }
      return lines.join('\n');
    }

    if (this.pendingCreation) {
      switch (this.pendingCreation.step) {
        case 'select-worker':
          return [
            '<b>Automation Hub</b>',
            '',
            'Select worker session:',
          ].join('\n');

        case 'select-orchestrator':
          return [
            '<b>Automation Hub</b>',
            '',
            `Worker: <b>${this.pendingCreation.workerSession}</b>`,
            'Select orchestrator session:',
          ].join('\n');

        case 'enter-task':
          return [
            '<b>Automation Hub</b>',
            '',
            `Worker: <b>${this.pendingCreation.workerSession}</b>`,
            `Orchestrator: <b>${this.pendingCreation.orchestratorSession}</b>`,
            '',
            'Type your task description below.',
          ].join('\n');

        case 'confirm-task':
          return [
            '<b>Automation Hub</b>',
            '',
            `Worker: <b>${this.pendingCreation.workerSession}</b>`,
            `Orchestrator: <b>${this.pendingCreation.orchestratorSession}</b>`,
            '',
            'Task:',
            `<i>${this.pendingCreation.taskDescription}</i>`,
            '',
            'Review and confirm to start.',
          ].join('\n');
      }
    }

    return [
      '<b>Automation Hub</b>',
      '',
      'No automation running.',
      'Tap New Automation to start.',
    ].join('\n');
  }

  /** Build inline keyboard based on current state. */
  private buildKeyboard(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

    // Detail view: show controls for the specific automation
    if (this.detailViewId !== null && this.activeAutomations.has(this.detailViewId)) {
      const auto = this.activeAutomations.get(this.detailViewId)!;
      const engineState = auto.engine.state;
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
      keyboard.push([
        { text: '\uD83D\uDD04 Refresh', callback_data: 'auto:refresh' },
      ]);
      if (this.activeAutomations.size > 1) {
        keyboard.push([
          { text: '\u2190 Back to List', callback_data: 'auto:back' },
        ]);
      }
      return { inline_keyboard: keyboard };
    }

    // List view: show "View Details" per automation + "New Automation"
    if (this.activeAutomations.size > 0 && this.detailViewId === null && !this.pendingCreation) {
      for (const [id, a] of this.activeAutomations) {
        keyboard.push([
          { text: `\uD83D\uDD0D ${a.workerSession} -> ${a.orchestratorSession}`, callback_data: `auto:details:${id}` },
        ]);
      }
      keyboard.push([{ text: '\uD83E\uDD16 New Automation', callback_data: 'auto:new' }]);
      keyboard.push([{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]);
      return { inline_keyboard: keyboard };
    }

    if (this.pendingCreation) {
      const sessions = this.getAllSessions();

      switch (this.pendingCreation.step) {
        case 'select-worker':
          for (const name of sessions) {
            keyboard.push([{ text: `\uD83D\uDD27 ${name}`, callback_data: `auto:w:${name}` }]);
          }
          keyboard.push([{ text: '\u274C Cancel', callback_data: 'auto:cancel' }]);
          break;

        case 'select-orchestrator':
          for (const name of sessions) {
            if (name !== this.pendingCreation.workerSession) {
              keyboard.push([{ text: `\uD83C\uDFAF ${name}`, callback_data: `auto:o:${name}` }]);
            }
          }
          keyboard.push([{ text: '\u274C Cancel', callback_data: 'auto:cancel' }]);
          break;

        case 'enter-task':
          keyboard.push([{ text: '\u274C Cancel', callback_data: 'auto:cancel' }]);
          break;

        case 'confirm-task':
          keyboard.push([{ text: '\u2705 Confirm', callback_data: 'auto:confirm' }]);
          keyboard.push([
            { text: '\u270F\uFE0F Edit', callback_data: 'auto:edit' },
            { text: '\u274C Cancel', callback_data: 'auto:cancel' },
          ]);
          break;
      }

      return { inline_keyboard: keyboard };
    }

    // Idle state
    keyboard.push([{ text: '\uD83E\uDD16 New Automation', callback_data: 'auto:new' }]);
    keyboard.push([{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]);
    return { inline_keyboard: keyboard };
  }
}
