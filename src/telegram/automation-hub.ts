/**
 * AutomationHubRenderer -- stub for TDD RED phase.
 */
import type { AutomationEngine, EngineConfig } from '../automation/engine.js';
import type { EventBus } from '../events/bus.js';

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
  constructor(
    api: unknown,
    chatId: number,
    getAllSessions: () => string[],
    engineFactory: (config: EngineConfig, bus: EventBus) => AutomationEngine,
    bus: EventBus,
  ) {}

  async render(_opts?: { forceNew?: boolean }): Promise<void> {}
  async handleCallback(_data: string): Promise<string> { return ''; }
  async completeCreation(_taskDescription: string): Promise<void> {}
  updateCycleInfo(_cycleNumber: number, _action: string): void {}
  isAwaitingTaskInput(): boolean { return false; }
  dispose(): void {}
}
