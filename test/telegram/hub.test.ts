import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HubRenderer, isNotModifiedError, isMessageNotFoundError } from '../../src/telegram/hub.js';

describe('HubRenderer', () => {
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

  function createMockStore(initialMessageId: number | null = null) {
    let storedId = initialMessageId;
    const storeCalls: { method: string; args?: unknown[] }[] = [];
    return {
      save(messageId: number) {
        storedId = messageId;
        storeCalls.push({ method: 'save', args: [messageId] });
      },
      load(): number | null {
        storeCalls.push({ method: 'load' });
        return storedId;
      },
      clear() {
        storedId = null;
        storeCalls.push({ method: 'clear' });
      },
      get storedId() { return storedId; },
      storeCalls,
    };
  }

  function createMockSessionManager(sessions: Array<{ name: string; status: string; pid?: number | null; createdAt?: string }> = []) {
    return {
      getActive() {
        return sessions;
      },
    };
  }

  describe('buildText', () => {
    it('shows empty state with help text when no sessions exist', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('<b>Sessions Hub</b>'), 'should have header');
      assert.ok(sentText.includes('No sessions connected.'), 'should show no sessions message');
      assert.ok(sentText.includes('npm run dev -- session-name'), 'should show start instructions');
    });

    it('shows session count in header', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'project-a', status: 'running' },
        { name: 'project-b', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'project-a');

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('(2 sessions)'), 'should show session count');
    });

    it('shows singular "session" for 1 session', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'solo', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'solo');

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('(1 session)'), 'should show singular session count');
      assert.ok(!sentText.includes('(1 sessions)'), 'should not show plural for 1');
    });

    it('marks active session with arrow prefix and bold name', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'project-a', status: 'running' },
        { name: 'project-b', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'project-a');

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('> <b>project-a</b> -- viewing'), 'active session should show viewing state');
      assert.ok(sentText.includes('   <b>project-b</b> -- hidden'), 'inactive running session should show hidden state');
      assert.ok(sentText.includes('idle'), 'running session should show idle execution state');
    });

    it('shows "busy" execution state when execStateMap has busy for session', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'project-a', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'project-a');
      hub.setExecState('project-a', 'busy');
      await hub.render();
      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('busy'), 'should show busy execution state');
      assert.ok(!sentText.includes('idle'), 'should not show idle when busy');
    });

    it('shows "idle" for remote sessions (not "remote")', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      // Provide getAllSessionNames that includes a remote session not in DB
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'remote-one', () => ['remote-one']);

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('idle'), 'remote session should show idle execution state');
      assert.ok(!sentText.includes('\u00B7 remote'), 'remote session should NOT show "remote" as execution state');
    });

    it('shows non-running status for inactive sessions', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'starting-session', status: 'starting' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('<b>starting-session</b> -- hidden \u00B7 starting'), 'should show hidden viewing + actual execution status');
    });

    it('uses bold formatting for session names', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'my-project', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'my-project');

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('<b>my-project</b>'), 'session name should be bold');
    });
  });

  describe('buildKeyboard', () => {
    it('shows switch button only for non-active sessions', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'active-one', status: 'running' },
        { name: 'inactive-one', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'active-one');

      await hub.render();

      // Check reply_markup in the sendMessage call
      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: unknown[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      // Flatten all callback_data values
      const allData: string[] = [];
      const allBtns: Array<{ text: string; callback_data: string }> = [];
      for (const row of keyboard as any[][]) {
        for (const btn of row) {
          if (btn.callback_data) {
            allData.push(btn.callback_data);
            allBtns.push(btn);
          }
        }
      }

      // Active session should NOT have switch button
      assert.ok(!allData.includes('hub:switch:active-one'), 'active session should not have switch button');
      // Inactive session should have switch button
      assert.ok(allData.includes('hub:switch:inactive-one'), 'inactive session should have switch button');
      // Both should have disconnect button
      assert.ok(allData.includes('hub:disconnect:active-one'), 'active session should have disconnect button');
      assert.ok(allData.includes('hub:disconnect:inactive-one'), 'inactive session should have disconnect button');

      // Active session close button should include session name (no switch button present)
      const activeDisconnect = allBtns.find(b => b.callback_data === 'hub:disconnect:active-one');
      assert.ok(activeDisconnect!.text.includes('active-one'), 'active session close button should include name');

      // Inactive session close button should be just the emoji (switch button already shows name)
      const inactiveDisconnect = allBtns.find(b => b.callback_data === 'hub:disconnect:inactive-one');
      assert.ok(!inactiveDisconnect!.text.includes('inactive-one'), 'inactive session close button should not include name');
      assert.equal(inactiveDisconnect!.text, '\uD83D\uDC80', 'inactive session close button should be just the X emoji');
    });

    it('close button shows only emoji when switch button is present', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'session-a', status: 'running' },
        { name: 'session-b', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'session-a');

      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      const allBtns: Array<{ text: string; callback_data: string }> = [];
      for (const row of keyboard as any[][]) {
        for (const btn of row) {
          if (btn.callback_data) allBtns.push(btn);
        }
      }

      // session-b is inactive, so has a switch button -- close should be emoji only
      const closeB = allBtns.find(b => b.callback_data === 'hub:disconnect:session-b');
      assert.equal(closeB!.text, '\uD83D\uDC80', 'inactive session close button should be just emoji');

      // session-a is active, no switch button -- close should include session name
      const closeA = allBtns.find(b => b.callback_data === 'hub:disconnect:session-a');
      assert.equal(closeA!.text, `\uD83D\uDC80 session-a`, 'active session close button should include name');
    });

    it('close button shows only emoji when all sessions have switch buttons (no active session)', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'proj-1', status: 'running' },
        { name: 'proj-2', status: 'running' },
      ]);
      // No active session -- all sessions get switch buttons
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      const allBtns: Array<{ text: string; callback_data: string }> = [];
      for (const row of keyboard as any[][]) {
        for (const btn of row) {
          if (btn.callback_data) allBtns.push(btn);
        }
      }

      // All sessions have switch buttons, so all close buttons should be just the emoji
      const close1 = allBtns.find(b => b.callback_data === 'hub:disconnect:proj-1');
      assert.equal(close1!.text, '\uD83D\uDC80', 'close button should be just emoji when switch button is present');

      const close2 = allBtns.find(b => b.callback_data === 'hub:disconnect:proj-2');
      assert.equal(close2!.text, '\uD83D\uDC80', 'close button should be just emoji when switch button is present');
    });

    it('callback data format is hub:switch:{name} and hub:disconnect:{name}', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'my-session', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: unknown[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      const allData: string[] = [];
      for (const row of keyboard as any[][]) {
        for (const btn of row) {
          if (btn.callback_data) allData.push(btn.callback_data);
        }
      }

      assert.ok(allData.includes('hub:switch:my-session'), 'should have switch button with name');
      assert.ok(allData.includes('hub:disconnect:my-session'), 'should have disconnect button with name');
    });

    it('has Details and Refresh buttons in bottom row', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'project-a', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'project-a');

      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      // Last row should have Details + Refresh buttons
      const lastRow = keyboard![keyboard!.length - 1];
      assert.equal(lastRow.length, 2, 'bottom row should have 2 buttons');
      assert.equal(lastRow[0].callback_data, 'hub:advanced', 'first button should be hub:advanced');
      assert.equal(lastRow[0].text, 'Details', 'toggle button should show Details when not in advanced mode');
      assert.equal(lastRow[1].callback_data, 'hub:refresh', 'second button should be hub:refresh');
      assert.ok(lastRow[1].text.includes('Refresh'), 'second button text should contain Refresh');
    });

    it('has Refresh button even with no sessions', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      const refreshButtons = keyboard!.flat().filter((b: any) => b.callback_data === 'hub:refresh');
      assert.equal(refreshButtons.length, 1, 'should have exactly one refresh button');
    });
  });

  describe('advanced mode', () => {
    it('toggleAdvanced flips advanced mode', () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      assert.equal(hub.isAdvanced, false, 'should start in normal mode');
      hub.toggleAdvanced();
      assert.equal(hub.isAdvanced, true, 'should be advanced after first toggle');
      hub.toggleAdvanced();
      assert.equal(hub.isAdvanced, false, 'should be normal after second toggle');
    });

    it('advanced view shows PID, status, and CET-formatted timestamp', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'my-session', status: 'running', pid: 12345, createdAt: '2026-03-05T14:30:00Z' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'my-session');

      hub.toggleAdvanced();
      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('PID: 12345'), 'advanced view should show PID');
      assert.ok(sentText.includes('viewing'), 'advanced view should show viewing state');
      assert.ok(sentText.includes('idle'), 'advanced view should show execution state');
      // Verify timestamp is present by computing expected locale string dynamically
      const expectedTime = new Date('2026-03-05T14:30:00Z').toLocaleString('en-GB', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      assert.ok(sentText.includes(expectedTime), `advanced view should show locale-formatted time (${expectedTime})`);
      assert.ok(!sentText.includes('Since:'), 'advanced view should not show raw "Since:" prefix');
    });

    it('PID detail line does not repeat execution state', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'my-session', status: 'running', pid: 12345, createdAt: '2026-03-05T14:30:00Z' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'my-session');

      hub.toggleAdvanced();
      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      // Find the PID detail line specifically
      const pidLine = sentText.split('\n').find(l => l.includes('PID:'));
      assert.ok(pidLine, 'should have a PID line');
      assert.ok(!pidLine!.includes('idle'), 'PID detail line should NOT contain execution state (idle)');
    });

    it('normal view does not show PID', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'my-session', status: 'running', pid: 12345, createdAt: '2026-03-05T14:30:00Z' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'my-session');

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(!sentText.includes('PID:'), 'normal view should NOT show PID');
    });

    it('bottom row shows Simple when advanced mode is on', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'project-a', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'project-a');

      hub.toggleAdvanced();
      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      const lastRow = keyboard![keyboard!.length - 1];
      assert.equal(lastRow[0].text, 'Simple', 'toggle button should show Simple when in advanced mode');
      assert.equal(lastRow[0].callback_data, 'hub:advanced', 'callback should still be hub:advanced');
    });
  });

  describe('render()', () => {
    it('sends new message when no hubMessageId exists', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render();

      assert.equal(api.calls.length, 1);
      assert.equal(api.calls[0].method, 'sendMessage');
      assert.equal(api.calls[0].args[0], 123); // chatId
    });

    it('edits existing message when hubMessageId exists', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      // First render creates the message
      await hub.render();
      const sentMessageId = (api.calls[0] as any).args[0]; // message created

      api.calls.length = 0; // reset

      // Second render should edit
      await hub.render();

      assert.equal(api.calls.length, 1);
      assert.equal(api.calls[0].method, 'editMessageText');
    });

    it('sends with HTML parse_mode', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render();

      const opts = api.calls[0].args[2] as { parse_mode?: string };
      assert.equal(opts?.parse_mode, 'HTML');
    });

    it('suppresses "message is not modified" errors silently', async () => {
      const api = createMockApi();
      // Override editMessageText to throw "not modified"
      api.editMessageText = async () => {
        const err = new Error('Bad Request: message is not modified');
        throw err;
      };
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render(); // creates message
      // Should not throw
      await hub.render(); // edit that throws "not modified"
    });

    it('re-sends message if "message to edit not found" error', async () => {
      const api = createMockApi();
      let editCallCount = 0;
      api.editMessageText = async () => {
        editCallCount++;
        if (editCallCount === 1) {
          const err = new Error('Bad Request: message to edit not found');
          throw err;
        }
        return {};
      };
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render(); // creates message
      const sendCallsBefore = api.calls.filter(c => c.method === 'sendMessage').length;

      await hub.render(); // edit fails -> resets hubMessageId to null
      await hub.render(); // next render re-sends since hubMessageId is null

      const sendCallsAfter = api.calls.filter(c => c.method === 'sendMessage').length;
      assert.ok(sendCallsAfter > sendCallsBefore, 'should have sent a new message after edit-not-found');
    });
  });

  describe('HubStore integration', () => {
    it('constructor deletes old hub message from store on creation', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const store = createMockStore(999);

      // Creating HubRenderer with a store that has an old message ID should trigger delete
      const _hub = new HubRenderer(api as any, 123, sm as any, () => null, undefined, store as any);

      // Wait for the deleteMessage promise to resolve
      await new Promise(resolve => setTimeout(resolve, 10));

      const deleteCalls = api.calls.filter(c => c.method === 'deleteMessage');
      assert.equal(deleteCalls.length, 1, 'should call deleteMessage for old hub message');
      assert.equal(deleteCalls[0].args[1], 999, 'should delete the stored message ID');
      assert.equal(store.storedId, null, 'store should be cleared after deleting old message');
    });

    it('constructor does nothing when store has no saved message', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const store = createMockStore(null);

      const _hub = new HubRenderer(api as any, 123, sm as any, () => null, undefined, store as any);

      await new Promise(resolve => setTimeout(resolve, 10));

      const deleteCalls = api.calls.filter(c => c.method === 'deleteMessage');
      assert.equal(deleteCalls.length, 0, 'should not call deleteMessage when no stored ID');
    });

    it('render() saves new message ID to store', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const store = createMockStore(null);

      const hub = new HubRenderer(api as any, 123, sm as any, () => null, undefined, store as any);
      await hub.render();

      const saveCalls = store.storeCalls.filter(c => c.method === 'save');
      assert.equal(saveCalls.length, 1, 'should save message ID after sending');
      assert.equal(saveCalls[0].args![0], 101, 'should save the new message ID (101 = counter start + 1)');
    });

    it('render() with forceNew clears store before sending fresh message', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const store = createMockStore(null);

      const hub = new HubRenderer(api as any, 123, sm as any, () => null, undefined, store as any);
      await hub.render(); // first render creates message

      // Force new render should clear store, then save new ID
      await hub.render({ forceNew: true });

      const clearCalls = store.storeCalls.filter(c => c.method === 'clear');
      // First clear is from constructor (store had null), second from forceNew
      assert.ok(clearCalls.length >= 1, 'should clear store on forceNew');
    });
  });

  describe('render serialization', () => {
    /** Mock API with configurable delay on sendMessage to expose race conditions. */
    function createSlowMockApi(sendDelayMs = 50) {
      const calls: { method: string; args: unknown[] }[] = [];
      let messageIdCounter = 100;
      return {
        async sendMessage(chatId: number, text: string, opts?: unknown) {
          await new Promise(resolve => setTimeout(resolve, sendDelayMs));
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

    it('concurrent render() calls with hubMessageId=null produce exactly 1 sendMessage', async () => {
      const api = createSlowMockApi(30);
      const sm = createMockSessionManager([
        { name: 'test-session', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'test-session');

      // Fire 3 render() calls concurrently -- all see hubMessageId=null initially
      await Promise.all([hub.render(), hub.render(), hub.render()]);

      const sendCalls = api.calls.filter(c => c.method === 'sendMessage');
      const editCalls = api.calls.filter(c => c.method === 'editMessageText');

      assert.equal(sendCalls.length, 1, 'should have exactly 1 sendMessage call');
      assert.equal(editCalls.length, 2, 'should have exactly 2 editMessageText calls');
    });

    it('sequential render() calls produce 1 send then edits', async () => {
      const api = createSlowMockApi(10);
      const sm = createMockSessionManager([
        { name: 'test-session', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'test-session');

      await hub.render();
      await hub.render();
      await hub.render();

      const sendCalls = api.calls.filter(c => c.method === 'sendMessage');
      const editCalls = api.calls.filter(c => c.method === 'editMessageText');

      assert.equal(sendCalls.length, 1, 'should have exactly 1 sendMessage call');
      assert.equal(editCalls.length, 2, 'should have exactly 2 editMessageText calls');
    });

    it('forceNew still works correctly with serialization', async () => {
      const api = createSlowMockApi(10);
      const sm = createMockSessionManager([
        { name: 'test-session', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'test-session');

      await hub.render(); // initial send
      await hub.render({ forceNew: true }); // delete + re-send

      const sendCalls = api.calls.filter(c => c.method === 'sendMessage');
      const deleteCalls = api.calls.filter(c => c.method === 'deleteMessage');

      assert.equal(sendCalls.length, 2, 'forceNew should trigger a second sendMessage');
      assert.equal(deleteCalls.length, 1, 'forceNew should delete old message');
    });

    it('if sendMessage fails, subsequent render() retries sendMessage', async () => {
      let sendAttempts = 0;
      const api = createSlowMockApi(10);
      const originalSendMessage = api.sendMessage.bind(api);
      api.sendMessage = async (chatId: number, text: string, opts?: unknown) => {
        sendAttempts++;
        if (sendAttempts === 1) {
          api.calls.push({ method: 'sendMessage', args: [chatId, text, opts] });
          throw new Error('Network error');
        }
        return originalSendMessage(chatId, text, opts);
      };
      const sm = createMockSessionManager([
        { name: 'test-session', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'test-session');

      await hub.render(); // fails
      await hub.render(); // should retry sendMessage since hubMessageId is still null

      const sendCalls = api.calls.filter(c => c.method === 'sendMessage');
      assert.equal(sendCalls.length, 2, 'should retry sendMessage after failure (hubMessageId stays null)');
      assert.equal(sendAttempts, 2, 'should have attempted sendMessage twice');
    });
  });

  describe('error helpers', () => {
    it('isNotModifiedError detects "not modified" in message', () => {
      assert.equal(isNotModifiedError(new Error('message is not modified')), true);
      assert.equal(isNotModifiedError(new Error('something else')), false);
      assert.equal(isNotModifiedError(null), false);
    });

    it('isMessageNotFoundError detects "message to edit not found"', () => {
      assert.equal(isMessageNotFoundError(new Error('message to edit not found')), true);
      assert.equal(isMessageNotFoundError(new Error('something else')), false);
      assert.equal(isMessageNotFoundError(null), false);
    });
  });
});
