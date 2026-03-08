/**
 * AutomationHubRenderer -- Telegram message manager for the automation lifecycle.
 *
 * Handles the full automation flow via a single editable hub message:
 * - Creation flow: select worker -> select orchestrator -> enter task description
 * - Status display: shows engine state, cycle count, last action
 * - Controls: pause/resume/stop via inline buttons
 *
 * Follows the same renderQueue serialization pattern as HubRenderer.
 */
import type { AutomationEngine, EngineConfig } from '../automation/engine.js';
import type { EventBus } from '../events/bus.js';
import { isNotModifiedError, isMessageNotFoundError } from './hub.js';
import { logError } from '../logging/logger.js';

export interface PendingCreation {
  step: 'select-worker' | 'select-orchestrator' | 'enter-task';
  workerSession?: string;
  orchestratorSession?: string;
}

export interface ActiveAutomation {
  engine: AutomationEngine;
  workerSession: string;
  orchestratorSession: string;
  taskDescription: string;
  cycleCount: number;
  lastAction: string | null;
}

export class AutomationHubRenderer {
  private hubMessageId: number | null = null;
  private renderQueue: Promise<void> = Promise.resolve();
  private pendingCreation: PendingCreation | null = null;
  private activeAutomation: ActiveAutomation | null = null;

  private stateChangeHandler: ((state: string) => void) | null = null;
  private cycleCompleteHandler: ((cycleNumber: number, action: string) => void) | null = null;
  private escalationHandler: ((reason: string) => void) | null = null;
  private doneHandler: ((summary: string) => void) | null = null;
  private errorHandler: ((error: string) => void) | null = null;

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
      await this.render();
      return 'Select a worker session';
    }

    if (data === 'auto:cancel') {
      this.pendingCreation = null;
      await this.render();
      return 'Creation cancelled';
    }

    if (data.startsWith('auto:w:')) {
      const sessionName = data.slice('auto:w:'.length);
      const sessions = this.getAllSessions();
      if (!sessions.includes(sessionName)) {
        // Stale session -- reset to idle
        this.pendingCreation = null;
        await this.render();
        return 'Session not found';
      }
      this.pendingCreation = {
        step: 'select-orchestrator',
        workerSession: sessionName,
      };
      await this.render();
      return 'Select an orchestrator session';
    }

    if (data.startsWith('auto:o:')) {
      const sessionName = data.slice('auto:o:'.length);
      this.pendingCreation = {
        ...this.pendingCreation!,
        step: 'enter-task',
        orchestratorSession: sessionName,
      };
      await this.render();
      return 'Enter your task description';
    }

    if (data === 'auto:pause' && this.activeAutomation) {
      this.activeAutomation.engine.pause();
      await this.render();
      return 'Automation paused';
    }

    if (data === 'auto:resume' && this.activeAutomation) {
      this.activeAutomation.engine.resume();
      await this.render();
      return 'Automation resumed';
    }

    if (data === 'auto:stop' && this.activeAutomation) {
      // Clean up error handler before stopping to prevent ghost notifications
      if (this.errorHandler) {
        this.bus.off('automation:error', this.errorHandler);
        this.errorHandler = null;
      }
      this.activeAutomation.engine.stop();
      this.activeAutomation = null;
      await this.render();
      return 'Automation stopped';
    }

    if (data === 'auto:refresh') {
      await this.render();
      return 'Refreshed';
    }

    return '';
  }

  /**
   * Final step of creation flow. Creates engine via factory, subscribes to
   * bus events, starts engine, transitions to active automation state.
   */
  async completeCreation(taskDescription: string): Promise<void> {
    if (!this.pendingCreation || this.pendingCreation.step !== 'enter-task') return;
    if (!this.pendingCreation.workerSession || !this.pendingCreation.orchestratorSession) return;

    const config: EngineConfig = {
      workerSession: this.pendingCreation.workerSession,
      orchestratorSession: this.pendingCreation.orchestratorSession,
      taskDescription,
    };

    const engine = this.engineFactory(config, this.bus);

    this.activeAutomation = {
      engine,
      workerSession: config.workerSession,
      orchestratorSession: config.orchestratorSession,
      taskDescription,
      cycleCount: 0,
      lastAction: null,
    };

    // Subscribe to bus events
    this.stateChangeHandler = (_state: string) => {
      this.render();
    };
    this.cycleCompleteHandler = (cycleNumber: number, action: string) => {
      this.updateCycleInfo(cycleNumber, action);
      this.render();
    };
    this.escalationHandler = (reason: string) => {
      // Send standalone notification so user gets a notification sound
      this.api.sendMessage(this.chatId, `Automation escalated: ${reason}`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]],
        },
      }).catch(() => {});
      this.render();
    };

    this.doneHandler = (summary: string) => {
      this.api.sendMessage(this.chatId, `\u2705 Automation complete: ${summary}`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]],
        },
      }).catch(() => {});
      this.activeAutomation = null;
      this.render();
    };

    this.errorHandler = (error: string) => {
      // Send standalone notification (separate from hub message) so user gets a notification sound
      this.api.sendMessage(this.chatId, `Automation stopped: ${error}`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]],
        },
      }).catch(() => {});
      // Also re-render hub to show stopped state
      this.render();
    };

    this.bus.on('automation:state-change', this.stateChangeHandler);
    this.bus.on('automation:cycle-complete', this.cycleCompleteHandler);
    this.bus.on('automation:escalation', this.escalationHandler);
    this.bus.on('automation:done', this.doneHandler);
    this.bus.on('automation:error', this.errorHandler);

    this.pendingCreation = null;
    engine.start();
    await this.render();
  }

  /** Update cycle count and last action for the active automation. */
  updateCycleInfo(cycleNumber: number, action: string): void {
    if (!this.activeAutomation) return;
    this.activeAutomation.cycleCount = cycleNumber;
    this.activeAutomation.lastAction = action;
  }

  /** Returns true if the given session is the worker in an active automation. */
  isAutomatedSession(sessionName: string): boolean {
    return this.activeAutomation !== null && this.activeAutomation.workerSession === sessionName;
  }

  /** Returns true iff currently in the enter-task creation step. */
  isAwaitingTaskInput(): boolean {
    return this.pendingCreation?.step === 'enter-task';
  }

  /** Clean up bus listeners and stop engine if running. */
  dispose(): void {
    if (this.stateChangeHandler) {
      this.bus.off('automation:state-change', this.stateChangeHandler);
      this.stateChangeHandler = null;
    }
    if (this.cycleCompleteHandler) {
      this.bus.off('automation:cycle-complete', this.cycleCompleteHandler);
      this.cycleCompleteHandler = null;
    }
    if (this.escalationHandler) {
      this.bus.off('automation:escalation', this.escalationHandler);
      this.escalationHandler = null;
    }
    if (this.doneHandler) {
      this.bus.off('automation:done', this.doneHandler);
      this.doneHandler = null;
    }
    if (this.errorHandler) {
      this.bus.off('automation:error', this.errorHandler);
      this.errorHandler = null;
    }
    if (this.activeAutomation) {
      this.activeAutomation.engine.stop();
      this.activeAutomation = null;
    }
  }

  /** Build HTML text based on current state. */
  private buildText(): string {
    if (this.activeAutomation) {
      const a = this.activeAutomation;
      const lines = [
        '<b>Automation Hub</b>',
        '',
        `Worker: <b>${a.workerSession}</b> -> Orchestrator: <b>${a.orchestratorSession}</b>`,
        `Task: ${a.taskDescription}`,
        '',
        `Status: ${a.engine.state} | Cycles: ${a.cycleCount}`,
      ];
      if (a.lastAction) {
        lines.push(`Last: ${a.lastAction}`);
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

    if (this.activeAutomation) {
      const engineState = this.activeAutomation.engine.state;
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
      }

      return { inline_keyboard: keyboard };
    }

    // Idle state
    keyboard.push([{ text: '\uD83E\uDD16 New Automation', callback_data: 'auto:new' }]);
    keyboard.push([{ text: '\uD83D\uDDD1 Delete', callback_data: 'action:delete' }]);
    return { inline_keyboard: keyboard };
  }
}
