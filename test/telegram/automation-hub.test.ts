import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationHubRenderer } from '../../src/telegram/automation-hub.js';
import type { PendingCreation, ActiveAutomation } from '../../src/telegram/automation-hub.js';
import { EventBus } from '../../src/events/bus.js';

describe('AutomationHubRenderer', () => {
  // --- Helpers ---

  function createMockApi() {
    const calls: { method: string; args: unknown[] }[] = [];
    let messageIdCounter = 100;
    return {
      async sendMessage(chatId: number, text: string, opts?: unknown) {
        const id = ++messageIdCounter;
        calls.push({ method: 'sendMessage', args: [chatId, text, opts] });
        return { message_id: id };
      },
      async editMessageText(chatId: number, messageId: number, text: string, opts?: unknown) {
        calls.push({ method: 'editMessageText', args: [chatId, messageId, text, opts] });
        return {};
      },
      async deleteMessage(chatId: number, messageId: number) {
        calls.push({ method: 'deleteMessage', args: [chatId, messageId] });
        return {};
      },
      calls,
    };
  }

  function createMockEngine(initialState = 'idle' as string) {
    let _state = initialState;
    const engineCalls: string[] = [];
    return {
      get state() { return _state; },
      set state(s: string) { _state = s; },
      start() { engineCalls.push('start'); _state = 'idle'; },
      stop() { engineCalls.push('stop'); _state = 'stopped'; },
      pause() { engineCalls.push('pause'); _state = 'paused'; },
      resume() { engineCalls.push('resume'); _state = 'idle'; },
      engineCalls,
    };
  }

  function createHub(
    api: ReturnType<typeof createMockApi>,
    opts?: {
      sessions?: string[];
      engineFactory?: (config: unknown, bus: EventBus) => ReturnType<typeof createMockEngine>;
      bus?: EventBus;
    },
  ) {
    const sessions = opts?.sessions ?? [];
    const bus = opts?.bus ?? new EventBus();
    const mockEngine = createMockEngine();
    const engineFactory = opts?.engineFactory ?? (() => mockEngine);
    const hub = new AutomationHubRenderer(
      api as any,
      123,
      () => sessions,
      engineFactory as any,
      bus,
    );
    // Wire onRender to trigger hub's own render (simulates parent hub integration)
    hub.onRender = async () => { await hub.render(); };
    return { hub, bus, mockEngine };
  }

  // --- Tests ---

  describe('idle state rendering', () => {
    it('render() with no active automation sends message with header and New Automation button', async () => {
      const api = createMockApi();
      const { hub } = createHub(api);

      await hub.render();

      assert.equal(api.calls.length, 1);
      assert.equal(api.calls[0].method, 'sendMessage');
      const text = api.calls[0].args[1] as string;
      assert.ok(text.includes('Automation Hub'), 'should have header');
      assert.ok(text.includes('No automation running'), 'should show idle message');

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');
      const allData = keyboard.flat().map((b: any) => b.callback_data);
      assert.ok(allData.includes('auto:new'), 'should have New Automation button');
    });

    it('render() with forceNew deletes old message and sends fresh one', async () => {
      const api = createMockApi();
      const { hub } = createHub(api);

      await hub.render(); // first render
      api.calls.length = 0;

      await hub.render({ forceNew: true });

      const deleteCalls = api.calls.filter(c => c.method === 'deleteMessage');
      const sendCalls = api.calls.filter(c => c.method === 'sendMessage');
      assert.equal(deleteCalls.length, 1, 'should delete old message');
      assert.equal(sendCalls.length, 1, 'should send new message');
    });
  });

  describe('creation flow', () => {
    it('handleCallback auto:new transitions to select-worker step with session buttons', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['worker-1', 'orch-1'] });

      await hub.render(); // initial
      api.calls.length = 0;

      await hub.handleCallback('auto:new');

      // Should have re-rendered
      assert.ok(api.calls.length > 0, 'should re-render after callback');
      const lastCall = api.calls[api.calls.length - 1];
      const text = lastCall.args[lastCall.method === 'sendMessage' ? 1 : 2] as string;
      assert.ok(text.includes('Select worker session'), 'should show worker selection text');

      const opts = lastCall.args[lastCall.method === 'sendMessage' ? 2 : 3] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      const allData = keyboard!.flat().map((b: any) => b.callback_data);
      assert.ok(allData.includes('auto:w:worker-1'), 'should have worker session button');
      assert.ok(allData.includes('auto:w:orch-1'), 'should have orch session button as worker option');
      assert.ok(allData.includes('auto:cancel'), 'should have cancel button');
    });

    it('handleCallback auto:w:<name> transitions to select-orchestrator (worker excluded)', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['my-worker', 'my-orch', 'extra'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      api.calls.length = 0;

      await hub.handleCallback('auto:w:my-worker');

      const lastCall = api.calls[api.calls.length - 1];
      const text = lastCall.args[lastCall.method === 'sendMessage' ? 1 : 2] as string;
      assert.ok(text.includes('Select orchestrator session'), 'should show orchestrator selection text');
      assert.ok(text.includes('my-worker'), 'should show selected worker name');

      const opts = lastCall.args[lastCall.method === 'sendMessage' ? 2 : 3] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      const allData = keyboard!.flat().map((b: any) => b.callback_data);
      assert.ok(!allData.includes('auto:o:my-worker'), 'worker should be excluded from orchestrator list');
      assert.ok(allData.includes('auto:o:my-orch'), 'should have orchestrator session buttons');
      assert.ok(allData.includes('auto:o:extra'), 'should have extra session as orchestrator option');
    });

    it('handleCallback auto:o:<name> transitions to enter-task step', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['worker-1', 'orch-1'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:worker-1');
      api.calls.length = 0;

      await hub.handleCallback('auto:o:orch-1');

      const lastCall = api.calls[api.calls.length - 1];
      const text = lastCall.args[lastCall.method === 'sendMessage' ? 1 : 2] as string;
      assert.ok(text.includes('task description'), 'should prompt for task description');
      assert.ok(text.includes('worker-1'), 'should show worker name');
      assert.ok(text.includes('orch-1'), 'should show orchestrator name');
    });

    it('completeCreation calls engineFactory with correct config and starts engine', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      let factoryCalledWith: unknown = null;
      const mockEng = createMockEngine();
      const factory = (config: unknown, b: EventBus) => {
        factoryCalledWith = config;
        return mockEng;
      };

      const { hub } = createHub(api, { sessions: ['w', 'o'], engineFactory: factory as any, bus });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      api.calls.length = 0;

      await hub.completeCreation('run all tests');

      assert.ok(factoryCalledWith !== null, 'should call engineFactory');
      const config = factoryCalledWith as any;
      assert.equal(config.workerSession, 'w');
      assert.equal(config.orchestratorSession, 'o');
      assert.equal(config.taskDescription, 'run all tests');
      assert.ok(mockEng.engineCalls.includes('start'), 'should call engine.start()');
    });

    it('isAwaitingTaskInput returns true only during enter-task step', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['w', 'o'] });

      assert.equal(hub.isAwaitingTaskInput(), false, 'false initially');

      await hub.render();
      await hub.handleCallback('auto:new');
      assert.equal(hub.isAwaitingTaskInput(), false, 'false during select-worker');

      await hub.handleCallback('auto:w:w');
      assert.equal(hub.isAwaitingTaskInput(), false, 'false during select-orchestrator');

      await hub.handleCallback('auto:o:o');
      assert.equal(hub.isAwaitingTaskInput(), true, 'true during enter-task');
    });
  });

  describe('active automation rendering', () => {
    it('render with active automation shows status, cycle count, last action, and pause/stop buttons', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['w', 'o'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.completeCreation('deploy app');
      api.calls.length = 0;

      hub.updateCycleInfo(3, 'COMMAND: npm test');
      await hub.render();

      const lastCall = api.calls[api.calls.length - 1];
      const text = lastCall.args[lastCall.method === 'sendMessage' ? 1 : 2] as string;
      assert.ok(text.includes('idle'), 'should show engine state');
      assert.ok(text.includes('3'), 'should show cycle count');
      assert.ok(text.includes('COMMAND: npm test'), 'should show last action');

      const opts = lastCall.args[lastCall.method === 'sendMessage' ? 2 : 3] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      const allData = keyboard!.flat().map((b: any) => b.callback_data);
      assert.ok(allData.includes('auto:pause'), 'should have pause button');
      assert.ok(allData.includes('auto:stop'), 'should have stop button');
    });

    it('render with paused automation shows resume/stop buttons instead of pause/stop', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['w', 'o'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.completeCreation('fix bugs');
      // Simulate engine being paused after creation
      mockEng.state = 'paused';
      api.calls.length = 0;

      await hub.render();

      const lastCall = api.calls[api.calls.length - 1];
      const opts = lastCall.args[lastCall.method === 'sendMessage' ? 2 : 3] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      const allData = keyboard!.flat().map((b: any) => b.callback_data);
      assert.ok(allData.includes('auto:resume'), 'should have resume button');
      assert.ok(allData.includes('auto:stop'), 'should have stop button');
      assert.ok(!allData.includes('auto:pause'), 'should NOT have pause button');
    });

    it('updateCycleInfo updates cycle count and last action visible on next render', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['w', 'o'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.completeCreation('run tests');
      api.calls.length = 0;

      hub.updateCycleInfo(5, 'ENTER');
      await hub.render();

      const lastCall = api.calls[api.calls.length - 1];
      const text = lastCall.args[lastCall.method === 'sendMessage' ? 1 : 2] as string;
      assert.ok(text.includes('5'), 'should show updated cycle count');
      assert.ok(text.includes('ENTER'), 'should show updated last action');
    });
  });

  describe('engine control callbacks', () => {
    it('handleCallback auto:pause calls engine.pause() and re-renders', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['w', 'o'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.completeCreation('task');
      api.calls.length = 0;

      await hub.handleCallback('auto:pause');

      assert.ok(mockEng.engineCalls.includes('pause'), 'should call engine.pause()');
      assert.ok(api.calls.length > 0, 'should re-render');
    });

    it('handleCallback auto:resume calls engine.resume() and re-renders', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('paused');
      const { hub } = createHub(api, {
        sessions: ['w', 'o'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.completeCreation('task');
      api.calls.length = 0;

      await hub.handleCallback('auto:resume');

      assert.ok(mockEng.engineCalls.includes('resume'), 'should call engine.resume()');
      assert.ok(api.calls.length > 0, 'should re-render');
    });

    it('handleCallback auto:stop calls engine.stop(), clears active automation, re-renders', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['w', 'o'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.completeCreation('task');
      api.calls.length = 0;

      await hub.handleCallback('auto:stop');

      assert.ok(mockEng.engineCalls.includes('stop'), 'should call engine.stop()');
      // Re-render should show idle state (no automation)
      const lastCall = api.calls[api.calls.length - 1];
      const text = lastCall.args[lastCall.method === 'sendMessage' ? 1 : 2] as string;
      assert.ok(text.includes('No automation running'), 'should show idle state after stop');
    });

    it('handleCallback auto:cancel clears pending creation and re-renders to idle', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['w', 'o'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      api.calls.length = 0;

      await hub.handleCallback('auto:cancel');

      const lastCall = api.calls[api.calls.length - 1];
      const text = lastCall.args[lastCall.method === 'sendMessage' ? 1 : 2] as string;
      assert.ok(text.includes('No automation running'), 'should return to idle state');
      assert.equal(hub.isAwaitingTaskInput(), false, 'should not be awaiting task input');
    });
  });

  describe('notification delete buttons', () => {
    it('error notification (automation stopped) includes reply_markup with action:delete button', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['w', 'o'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.completeCreation('run tests');
      api.calls.length = 0;

      // Trigger error event
      bus.emit('automation:error', 'something broke');

      // Wait for async sendMessage
      await new Promise(resolve => setTimeout(resolve, 50));

      // Find the standalone sendMessage for the error notification (not the hub re-render)
      const errorSend = api.calls.find(
        c => c.method === 'sendMessage' && (c.args[1] as string).includes('Automation stopped'),
      );
      assert.ok(errorSend, 'should send error notification');
      const opts = errorSend!.args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'error notification should have inline keyboard');
      const allData = keyboard!.flat().map((b: any) => b.callback_data);
      assert.ok(allData.includes('action:delete'), 'error notification should have action:delete button');
    });

    it('escalation notification includes reply_markup with action:delete button', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['w', 'o'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.completeCreation('run tests');
      api.calls.length = 0;

      // Trigger escalation event
      bus.emit('automation:escalation', 'needs human help');

      // Wait for async sendMessage
      await new Promise(resolve => setTimeout(resolve, 50));

      // Find the standalone sendMessage for the escalation notification
      const escalationSend = api.calls.find(
        c => c.method === 'sendMessage' && (c.args[1] as string).includes('Automation escalated'),
      );
      assert.ok(escalationSend, 'should send escalation notification');
      const opts = escalationSend!.args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'escalation notification should have inline keyboard');
      const allData = keyboard!.flat().map((b: any) => b.callback_data);
      assert.ok(allData.includes('action:delete'), 'escalation notification should have action:delete button');
    });
  });

  describe('idle state delete button', () => {
    it('idle state keyboard includes action:delete button alongside auto:new', async () => {
      const api = createMockApi();
      const { hub } = createHub(api);

      await hub.render();

      assert.equal(api.calls.length, 1);
      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');
      const allData = keyboard!.flat().map((b: any) => b.callback_data);
      assert.ok(allData.includes('auto:new'), 'should have New Automation button');
      assert.ok(allData.includes('action:delete'), 'should have Delete button');
    });
  });

  describe('isAutomatedSession', () => {
    it('returns false when no automation is active', () => {
      const api = createMockApi();
      const { hub } = createHub(api);

      assert.equal(hub.isAutomatedSession('anything'), false);
    });

    it('returns true for the worker session when automation is active', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['worker', 'orchestrator'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:worker');
      await hub.handleCallback('auto:o:orchestrator');
      await hub.completeCreation('do stuff');

      assert.equal(hub.isAutomatedSession('worker'), true);
    });

    it('returns false for a different session name when automation is active', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['worker', 'orchestrator'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:worker');
      await hub.handleCallback('auto:o:orchestrator');
      await hub.completeCreation('do stuff');

      assert.equal(hub.isAutomatedSession('other'), false);
    });

    it('returns false for the orchestrator session name when automation is active', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      const mockEng = createMockEngine('idle');
      const { hub } = createHub(api, {
        sessions: ['worker', 'orchestrator'],
        engineFactory: () => mockEng as any,
        bus,
      });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:worker');
      await hub.handleCallback('auto:o:orchestrator');
      await hub.completeCreation('do stuff');

      assert.equal(hub.isAutomatedSession('orchestrator'), false);
    });
  });

  describe('confirm-task step', () => {
    it('submitTaskForReview stores task text and transitions to confirm-task step', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['w', 'o'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      api.calls.length = 0;

      await hub.submitTaskForReview('run all tests');

      const pending = hub.pendingCreationInfo;
      assert.ok(pending, 'should still have pending creation');
      assert.equal(pending!.step, 'confirm-task', 'should be in confirm-task step');
      assert.equal(pending!.taskDescription, 'run all tests', 'should store task description');
    });

    it('confirm-task buildText shows worker, orchestrator, task, and review prompt', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['w', 'o'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.submitTaskForReview('deploy the app');
      api.calls.length = 0;

      await hub.render();

      const lastCall = api.calls[api.calls.length - 1];
      const text = lastCall.args[lastCall.method === 'sendMessage' ? 1 : 2] as string;
      assert.ok(text.includes('w'), 'should show worker name');
      assert.ok(text.includes('o'), 'should show orchestrator name');
      assert.ok(text.includes('deploy the app'), 'should show task description');
      assert.ok(text.includes('Review and confirm'), 'should show review prompt');
    });

    it('confirm-task buildKeyboard shows Confirm, Edit, and Cancel buttons', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['w', 'o'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.submitTaskForReview('run tests');
      api.calls.length = 0;

      await hub.render();

      const lastCall = api.calls[api.calls.length - 1];
      const opts = lastCall.args[lastCall.method === 'sendMessage' ? 2 : 3] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');
      const allData = keyboard!.flat().map((b: any) => b.callback_data);
      assert.ok(allData.includes('auto:confirm'), 'should have Confirm button');
      assert.ok(allData.includes('auto:edit'), 'should have Edit button');
      assert.ok(allData.includes('auto:cancel'), 'should have Cancel button');

      // Check button labels
      const allText = keyboard!.flat().map((b: any) => b.text);
      assert.ok(allText.some((t: string) => t.includes('Confirm')), 'should have Confirm label');
      assert.ok(allText.some((t: string) => t.includes('Edit')), 'should have Edit label');
      assert.ok(allText.some((t: string) => t.includes('Cancel')), 'should have Cancel label');
    });

    it('handleCallback auto:confirm during confirm-task calls completeCreation and starts engine', async () => {
      const api = createMockApi();
      const bus = new EventBus();
      let factoryCalledWith: unknown = null;
      const mockEng = createMockEngine();
      const factory = (config: unknown, _b: EventBus) => {
        factoryCalledWith = config;
        return mockEng;
      };
      const { hub } = createHub(api, { sessions: ['w', 'o'], engineFactory: factory as any, bus });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.submitTaskForReview('run all tests');
      api.calls.length = 0;

      const result = await hub.handleCallback('auto:confirm');

      assert.equal(result, 'Automation started');
      assert.ok(factoryCalledWith !== null, 'should call engineFactory');
      const config = factoryCalledWith as any;
      assert.equal(config.taskDescription, 'run all tests', 'should use stored task description');
      assert.ok(mockEng.engineCalls.includes('start'), 'should start engine');
      assert.equal(hub.pendingCreationInfo, null, 'pending creation should be cleared');
      assert.ok(hub.activeAutomationInfo !== null, 'should have active automation');
    });

    it('handleCallback auto:edit during confirm-task transitions back to enter-task', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['w', 'o'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.submitTaskForReview('old task text');
      api.calls.length = 0;

      const result = await hub.handleCallback('auto:edit');

      assert.equal(result, 'Edit your task description');
      assert.equal(hub.isAwaitingTaskInput(), true, 'should be back in enter-task step');
      const pending = hub.pendingCreationInfo;
      assert.ok(pending, 'should still have pending creation');
      assert.equal(pending!.step, 'enter-task');
      assert.equal(pending!.taskDescription, undefined, 'taskDescription should be cleared');
    });

    it('handleCallback auto:cancel during confirm-task resets to idle', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['w', 'o'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      await hub.submitTaskForReview('some task');
      api.calls.length = 0;

      const result = await hub.handleCallback('auto:cancel');

      assert.equal(result, 'Creation cancelled');
      assert.equal(hub.pendingCreationInfo, null, 'should be cleared');
      assert.equal(hub.isAwaitingTaskInput(), false, 'should not be awaiting input');
    });

    it('isAwaitingTaskInput returns false during confirm-task step', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['w', 'o'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      await hub.handleCallback('auto:w:w');
      await hub.handleCallback('auto:o:o');
      assert.equal(hub.isAwaitingTaskInput(), true, 'true during enter-task');

      await hub.submitTaskForReview('my task');
      assert.equal(hub.isAwaitingTaskInput(), false, 'false during confirm-task');
    });

    it('submitTaskForReview does nothing if not in enter-task step', async () => {
      const api = createMockApi();
      const { hub } = createHub(api, { sessions: ['w', 'o'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      // Currently in select-worker step
      api.calls.length = 0;

      await hub.submitTaskForReview('should be ignored');

      const pending = hub.pendingCreationInfo;
      assert.equal(pending!.step, 'select-worker', 'should still be in select-worker');
    });
  });

  describe('stale session handling', () => {
    it('handleCallback auto:w:<stale> where session no longer exists resets to idle with error', async () => {
      const api = createMockApi();
      // Sessions list does NOT include 'stale-session'
      const { hub } = createHub(api, { sessions: ['valid-session'] });

      await hub.render();
      await hub.handleCallback('auto:new');
      api.calls.length = 0;

      const result = await hub.handleCallback('auto:w:stale-session');

      // Should re-render to idle state
      const lastCall = api.calls[api.calls.length - 1];
      const text = lastCall.args[lastCall.method === 'sendMessage' ? 1 : 2] as string;
      assert.ok(text.includes('No automation running'), 'should reset to idle state');
    });
  });

  describe('render serialization', () => {
    it('concurrent render() calls produce exactly 1 sendMessage', async () => {
      const calls: { method: string; args: unknown[] }[] = [];
      let messageIdCounter = 100;
      const api = {
        async sendMessage(chatId: number, text: string, opts?: unknown) {
          await new Promise(resolve => setTimeout(resolve, 20));
          const id = ++messageIdCounter;
          calls.push({ method: 'sendMessage', args: [chatId, text, opts] });
          return { message_id: id };
        },
        async editMessageText(chatId: number, messageId: number, text: string, opts?: unknown) {
          calls.push({ method: 'editMessageText', args: [chatId, messageId, text, opts] });
          return {};
        },
        async deleteMessage(chatId: number, messageId: number) {
          calls.push({ method: 'deleteMessage', args: [chatId, messageId] });
          return {};
        },
        calls,
      };

      const bus = new EventBus();
      const hub = new AutomationHubRenderer(api as any, 123, () => [], () => createMockEngine() as any, bus);

      await Promise.all([hub.render(), hub.render(), hub.render()]);

      const sendCalls = calls.filter(c => c.method === 'sendMessage');
      const editCalls = calls.filter(c => c.method === 'editMessageText');
      assert.equal(sendCalls.length, 1, 'should have exactly 1 sendMessage');
      assert.equal(editCalls.length, 2, 'should have exactly 2 edits');
    });
  });
});
