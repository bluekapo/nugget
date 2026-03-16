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
      assert.ok(sentText.includes('<b>project-a</b> -- viewing \u00B7 idle'), 'active session should show viewing + idle dual status');
      assert.ok(sentText.includes('<b>project-b</b> -- hidden \u00B7 idle'), 'inactive running session should show hidden + idle dual status');
      assert.ok(sentText.includes('> '), 'active session should have arrow prefix');
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

    it('shows globe emoji and idle for truly remote sessions (isRemote returns true)', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      // Provide getAllSessionNames that includes a remote session not in DB
      // Pass isRemote callback that returns true for 'remote-one'
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'remote-one', () => ['remote-one'], (name: string) => name === 'remote-one');

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('idle'), 'remote session should show idle execution state');
      assert.ok(sentText.includes('\uD83C\uDF10'), 'truly remote session should show globe emoji');
      assert.ok(!sentText.includes('\u00B7 remote'), 'remote session should NOT show "remote" as execution state');
    });

    it('shows running status for local session missing from DB (not globe emoji)', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      // Session in router but NOT in DB, isRemote returns false (local orphan)
      const hub = new HubRenderer(api as any, 123, sm as any, () => null, () => ['local-orphan'], (name: string) => false);

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(!sentText.includes('\uD83C\uDF10'), 'local-no-DB session should NOT show globe emoji');
      assert.ok(sentText.includes('idle'), 'local-no-DB session should show idle (from execStateMap default)');
    });

    it('advanced view for local session missing from DB shows ? PID without globe', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      // Session in router but NOT in DB, isRemote returns false
      const hub = new HubRenderer(api as any, 123, sm as any, () => null, () => ['local-orphan'], (name: string) => false);
      hub.toggleAdvanced();

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('PID: ?'), 'should show ? PID for session missing from DB');
      assert.ok(!sentText.includes('\uD83C\uDF10'), 'local-no-DB session should NOT show globe emoji even in advanced mode');
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

    it('skull disconnect buttons have danger style, other buttons do not', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'active-sess', status: 'running' },
        { name: 'idle-sess', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'active-sess');

      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      const allBtns: Array<{ text: string; callback_data: string; style?: string }> = [];
      for (const row of keyboard as any[][]) {
        for (const btn of row) {
          if (btn.callback_data) allBtns.push(btn);
        }
      }

      // All disconnect (skull) buttons should have style: 'danger'
      const disconnectBtns = allBtns.filter(b => b.callback_data.startsWith('hub:disconnect:'));
      assert.ok(disconnectBtns.length >= 2, 'should have at least 2 disconnect buttons');
      for (const btn of disconnectBtns) {
        assert.equal(btn.style, 'danger', `disconnect button for ${btn.callback_data} should have style: danger`);
      }

      // Non-disconnect buttons (switch, refresh, details, cli-resume) should NOT have danger style
      const otherBtns = allBtns.filter(b => !b.callback_data.startsWith('hub:disconnect:'));
      assert.ok(otherBtns.length >= 1, 'should have at least 1 non-disconnect button');
      for (const btn of otherBtns) {
        assert.notEqual(btn.style, 'danger', `non-disconnect button ${btn.callback_data} should not have danger style`);
      }
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
      assert.ok(lastRow[0].text.includes('Details'), 'toggle button should show Details when not in advanced mode');
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
      assert.ok(lastRow[0].text.includes('Simple'), 'toggle button should show Simple when in advanced mode');
      assert.equal(lastRow[0].callback_data, 'hub:advanced', 'callback should still be hub:advanced');
    });

    it('advanced view shows PID and createdAt for remote session with metadata', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      // Remote session not in DB, but metadata provided via getRemoteMetadata
      const hub = new HubRenderer(
        api as any, 123, sm as any,
        () => 'remote-sess',
        () => ['remote-sess'],
        () => true, // isRemote
        undefined,
        undefined,
        (name: string) => name === 'remote-sess' ? { pid: 7777, createdAt: '2026-03-16T08:00:00' } : undefined,
      );

      hub.toggleAdvanced();
      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('PID: 7777'), 'advanced view should show remote PID from metadata');
      const expectedTime = new Date('2026-03-16T08:00:00Z').toLocaleString('en-GB', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      assert.ok(sentText.includes(expectedTime), `advanced view should show locale-formatted time for remote session (${expectedTime})`);
    });

    it('remote session without metadata shows ? | ? in advanced view', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(
        api as any, 123, sm as any,
        () => 'remote-no-meta',
        () => ['remote-no-meta'],
        () => true, // isRemote
        undefined,
        undefined,
        () => undefined, // no metadata
      );

      hub.toggleAdvanced();
      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('PID: ?'), 'remote session without metadata should show ? PID');
      assert.ok(sentText.includes('| ?'), 'remote session without metadata should show ? timestamp');
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
      const _hub = new HubRenderer(api as any, 123, sm as any, () => null, undefined, undefined, store as any);

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

      const _hub = new HubRenderer(api as any, 123, sm as any, () => null, undefined, undefined, store as any);

      await new Promise(resolve => setTimeout(resolve, 10));

      const deleteCalls = api.calls.filter(c => c.method === 'deleteMessage');
      assert.equal(deleteCalls.length, 0, 'should not call deleteMessage when no stored ID');
    });

    it('render() saves new message ID to store', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const store = createMockStore(null);

      const hub = new HubRenderer(api as any, 123, sm as any, () => null, undefined, undefined, store as any);
      await hub.render();

      const saveCalls = store.storeCalls.filter(c => c.method === 'save');
      assert.equal(saveCalls.length, 1, 'should save message ID after sending');
      assert.equal(saveCalls[0].args![0], 101, 'should save the new message ID (101 = counter start + 1)');
    });

    it('render() with forceNew clears store before sending fresh message', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const store = createMockStore(null);

      const hub = new HubRenderer(api as any, 123, sm as any, () => null, undefined, undefined, store as any);
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

  describe('active automation', () => {
    function createMockAutomationHub(active: boolean) {
      const autoInfo = active ? {
        engine: { state: 'executing' },
        workerSession: 'worker-1',
        orchestratorSession: 'orch-1',
        taskDescription: 'Fix bugs',
        cycleCount: 5,
        lastAction: 'COMMAND: npm test',
      } : null;
      const allAutos = active ? new Map([[1, autoInfo!]]) : new Map();
      return {
        get activeAutomationInfo() { return autoInfo; },
        get activeAutomationCount() { return allAutos.size; },
        get allAutomations() { return allAutos; },
        get pendingCreationInfo() { return null; },
      };
    }

    it('buildText shows normal session list with automation status line when active', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'worker-1', status: 'running' },
        { name: 'orch-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'worker-1');
      hub.setAutomationHub(createMockAutomationHub(true) as any);

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('<b>Sessions Hub</b>'), 'should show Sessions Hub header, not Automation Hub');
      assert.ok(sentText.includes('<b>worker-1</b>'), 'should show worker session in list');
      assert.ok(sentText.includes('<b>orch-1</b>'), 'should show orchestrator session in list');
      assert.ok(sentText.includes('\uD83E\uDD16 1 automation in progress'), 'should show automation status line');
      assert.ok(!sentText.includes('Automation Hub'), 'should NOT show Automation Hub header');
    });

    it('buildText shows automation status even with no sessions', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);
      hub.setAutomationHub(createMockAutomationHub(true) as any);

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('No sessions connected.'), 'should show empty state');
      assert.ok(sentText.includes('\uD83E\uDD16 1 automation in progress'), 'should show automation status');
    });

    it('buildKeyboard shows normal session buttons with Automations button when active', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'worker-1', status: 'running' },
        { name: 'orch-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'worker-1');
      hub.setAutomationHub(createMockAutomationHub(true) as any);

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

      // Should have normal hub buttons
      assert.ok(allBtns.some(b => b.callback_data === 'hub:switch:orch-1'), 'should have switch button for non-active session');
      assert.ok(allBtns.some(b => b.callback_data === 'hub:disconnect:worker-1'), 'should have disconnect button');
      assert.ok(allBtns.some(b => b.callback_data === 'hub:advanced'), 'should have details toggle');
      assert.ok(allBtns.some(b => b.callback_data === 'hub:refresh'), 'should have refresh button');

      // Should have Automations button instead of Automate
      const autoBtn = allBtns.find(b => b.callback_data === 'hub:automations');
      assert.ok(autoBtn, 'should have Automations button');
      assert.ok(autoBtn!.text.includes('Automations (1)'), 'button text should show count');
      assert.ok(!allBtns.some(b => b.callback_data === 'auto:new'), 'should NOT have Automate button when active');
    });

    it('buildKeyboard shows Automate button when no automation active', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'session-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'session-1');
      hub.setAutomationHub(createMockAutomationHub(false) as any);

      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      const allBtns: Array<{ text: string; callback_data: string }> = [];
      for (const row of keyboard as any[][]) {
        for (const btn of row) {
          if (btn.callback_data) allBtns.push(btn);
        }
      }

      assert.ok(allBtns.some(b => b.callback_data === 'auto:new'), 'should have Automate button when idle');
      assert.ok(!allBtns.some(b => b.callback_data === 'hub:automations'), 'should NOT have Automations button when idle');
    });

    it('buildText does not show automation status line when no automation active', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'session-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'session-1');
      hub.setAutomationHub(createMockAutomationHub(false) as any);

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(!sentText.includes('automation in progress'), 'should not show status when no automation');
    });

    it('session role indicators show [worker] and [orch] tags', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'worker-1', status: 'running' },
        { name: 'orch-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'worker-1');
      hub.setAutomationHub(createMockAutomationHub(true) as any);

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      // Find the worker line and check for [worker] tag
      const workerLine = sentText.split('\n').find(l => l.includes('worker-1'));
      assert.ok(workerLine, 'should have worker-1 line');
      assert.ok(workerLine!.includes('[worker]'), 'worker session should have [worker] tag');
      // Find the orch line and check for [orch] tag
      const orchLine = sentText.split('\n').find(l => l.includes('orch-1'));
      assert.ok(orchLine, 'should have orch-1 line');
      assert.ok(orchLine!.includes('[orch]'), 'orchestrator session should have [orch] tag');
    });

    it('no role tags when no automation active', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'worker-1', status: 'running' },
        { name: 'orch-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'worker-1');
      hub.setAutomationHub(createMockAutomationHub(false) as any);

      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(!sentText.includes('[worker]'), 'should not have [worker] tag when idle');
      assert.ok(!sentText.includes('[orch]'), 'should not have [orch] tag when idle');
    });

    it('automationView mode shows automation details', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'worker-1', status: 'running' },
        { name: 'orch-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'worker-1');
      hub.setAutomationHub(createMockAutomationHub(true) as any);

      hub.setHubView('automationDetails');
      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('Automation Details'), 'should show Automation Details header');
      assert.ok(sentText.includes('<b>worker-1</b>'), 'should show worker session name');
      assert.ok(sentText.includes('<b>orch-1</b>'), 'should show orchestrator session name');
      assert.ok(sentText.includes('Fix bugs'), 'should show task description');
      assert.ok(sentText.includes('Executing directive'), 'should show engine state label');
      assert.ok(sentText.includes('Cycles: 5'), 'should show cycle count');
      assert.ok(sentText.includes('COMMAND: npm test'), 'should show last action');
      assert.ok(!sentText.includes('Sessions Hub'), 'should NOT show Sessions Hub header');
    });

    it('automationView keyboard has pause/stop/refresh/back buttons', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'worker-1', status: 'running' },
        { name: 'orch-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'worker-1');
      hub.setAutomationHub(createMockAutomationHub(true) as any);

      hub.setHubView('automationDetails');
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

      assert.ok(allBtns.some(b => b.callback_data === 'auto:pause'), 'should have pause button');
      assert.ok(allBtns.some(b => b.callback_data === 'auto:stop'), 'should have stop button');
      assert.ok(allBtns.some(b => b.callback_data === 'auto:refresh'), 'should have refresh button');
      assert.ok(allBtns.some(b => b.callback_data === 'hub:auto-back'), 'should have back button');
      assert.ok(!allBtns.some(b => b.callback_data === 'hub:switch:orch-1'), 'should NOT have switch button');
      assert.ok(!allBtns.some(b => b.callback_data.startsWith('hub:disconnect')), 'should NOT have disconnect button');
    });

    it('automationView with no active automation shows empty state + back button', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'session-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'session-1');
      hub.setAutomationHub(createMockAutomationHub(false) as any);

      hub.setHubView('automationDetails');
      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('Automation Details'), 'should show Automation Details header');
      assert.ok(sentText.includes('No automation running'), 'should show no automation message');

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      const allBtns: Array<{ text: string; callback_data: string }> = [];
      for (const row of keyboard as any[][]) {
        for (const btn of row) {
          if (btn.callback_data) allBtns.push(btn);
        }
      }

      assert.ok(allBtns.some(b => b.callback_data === 'hub:auto-back'), 'should have back button');
      assert.equal(allBtns.length, 1, 'should only have back button');
    });

    it('setHubView transitions between all three states', () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      assert.equal(hub.hubView, 'sessions', 'should start in sessions state');
      hub.setHubView('automationHub');
      assert.equal(hub.hubView, 'automationHub', 'should be automationHub after set');
      hub.setHubView('automationDetails');
      assert.equal(hub.hubView, 'automationDetails', 'should be automationDetails after set');
      hub.setHubView('sessions');
      assert.equal(hub.hubView, 'sessions', 'should be sessions after set');
    });

    it('automationHub view shows summary with state, cycles, and truncated task', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'worker-1', status: 'running' },
        { name: 'orch-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'worker-1');
      const autoInfo = {
        engine: { state: 'executing' },
        workerSession: 'worker-1',
        orchestratorSession: 'orch-1',
        taskDescription: 'Fix all the bugs in the authentication module and deploy to production server quickly',
        cycleCount: 5,
        lastAction: 'COMMAND: npm test',
      };
      hub.setAutomationHub({
        get activeAutomationInfo() { return autoInfo; },
        get activeAutomationCount() { return 1; },
        get allAutomations() { return new Map([[1, autoInfo]]); },
        get pendingCreationInfo() { return null; },
      } as any);

      hub.setHubView('automationHub');
      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('<b>Automation Hub</b>'), 'should show Automation Hub header');
      assert.ok(sentText.includes('State: Executing directive'), 'should show engine state label');
      assert.ok(sentText.includes('Cycles: 5'), 'should show cycle count');
      assert.ok(sentText.includes('...'), 'should truncate long task description');
      assert.ok(!sentText.includes('Automation Details'), 'should NOT show Automation Details header');
      assert.ok(!sentText.includes('Sessions Hub'), 'should NOT show Sessions Hub header');
    });

    it('automationHub keyboard has View Details and Back buttons', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'worker-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'worker-1');
      hub.setAutomationHub(createMockAutomationHub(true) as any);

      hub.setHubView('automationHub');
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

      assert.ok(allBtns.some(b => b.callback_data === 'hub:auto-details'), 'should have View Details button');
      assert.ok(allBtns.some(b => b.text.includes('View Details')), 'button text should say View Details');
      assert.ok(allBtns.some(b => b.callback_data === 'hub:auto-back'), 'should have Back to Sessions button');
      assert.ok(allBtns.some(b => b.text.includes('Back to Sessions')), 'button text should say Back to Sessions');
      assert.ok(!allBtns.some(b => b.callback_data === 'auto:pause'), 'should NOT have pause button');
      assert.ok(!allBtns.some(b => b.callback_data === 'auto:stop'), 'should NOT have stop button');
      assert.ok(!allBtns.some(b => b.callback_data === 'auto:refresh'), 'should NOT have refresh button');
    });

    it('automationHub with no active automation shows empty state', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'session-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'session-1');
      hub.setAutomationHub(createMockAutomationHub(false) as any);

      hub.setHubView('automationHub');
      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('No automation running'), 'should show no automation message');
      assert.ok(sentText.includes('<b>Automation Hub</b>'), 'should show Automation Hub header');
      assert.ok(sentText.includes('configurable via /settings'), 'should show cycle limit hint');

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: any[][] } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      const allBtns: Array<{ text: string; callback_data: string }> = [];
      for (const row of keyboard as any[][]) {
        for (const btn of row) {
          if (btn.callback_data) allBtns.push(btn);
        }
      }

      assert.ok(allBtns.some(b => b.callback_data === 'hub:auto-back'), 'should have back button');
      assert.ok(!allBtns.some(b => b.callback_data === 'hub:auto-details'), 'should NOT have View Details button');
    });

    it('automationHub summary truncates long task descriptions at 80 chars', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([{ name: 'w', status: 'running' }]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'w');

      // Exactly 80 chars -- no truncation
      const task80 = 'a'.repeat(80);
      const auto80 = {
        engine: { state: 'executing' },
        workerSession: 'w',
        orchestratorSession: 'o',
        taskDescription: task80,
        cycleCount: 1,
        lastAction: null,
      };
      hub.setAutomationHub({
        get activeAutomationInfo() { return auto80; },
        get activeAutomationCount() { return 1; },
        get allAutomations() { return new Map([[1, auto80]]); },
        get pendingCreationInfo() { return null; },
      } as any);

      hub.setHubView('automationHub');
      await hub.render();

      const text80 = api.calls[0].args[1] as string;
      assert.ok(!text80.includes('...'), 'should NOT truncate 80-char task');
      assert.ok(text80.includes(task80), 'should show full 80-char task');

      // 81+ chars -- should truncate
      const task81 = 'b'.repeat(81);
      const auto81 = {
        engine: { state: 'executing' },
        workerSession: 'w',
        orchestratorSession: 'o',
        taskDescription: task81,
        cycleCount: 1,
        lastAction: null,
      };
      hub.setAutomationHub({
        get activeAutomationInfo() { return auto81; },
        get activeAutomationCount() { return 1; },
        get allAutomations() { return new Map([[1, auto81]]); },
        get pendingCreationInfo() { return null; },
      } as any);

      api.calls.length = 0;
      await hub.render({ forceNew: true });

      const text81 = api.calls.filter(c => c.method === 'sendMessage')[0]?.args[1] as string;
      assert.ok(text81.includes('...'), 'should truncate 81-char task with ...');
      assert.ok(!text81.includes(task81), 'should NOT show full 81-char task');
    });
  });

  describe('CLI view state', () => {
    it('buildText renders CLI content with session name header and pre block', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'my-session', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'my-session');

      hub.setCliContent('my-session', 'Hello from terminal');
      hub.setHubView('cli');
      await hub.render({ forceNew: true });

      const sentText = api.calls.filter(c => c.method === 'sendMessage')[0]?.args[1] as string;
      assert.ok(sentText.includes('<b>CLI of my-session</b>'), 'should have CLI header with session name');
      assert.ok(sentText.includes('<pre>'), 'should contain pre tag');
      assert.ok(sentText.includes('Hello from terminal'), 'should contain terminal content');
    });

    it('buildText returns fallback when CLI content has no session', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      hub.setHubView('cli');
      await hub.render();

      const sentText = api.calls[0].args[1] as string;
      assert.ok(sentText.includes('CLI View'), 'should show CLI View header');
      assert.ok(sentText.includes('No session selected'), 'should show no session fallback');
    });

    it('buildKeyboard returns CLI keyboard buttons plus Back to Sessions', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'test-sess', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'test-sess');

      hub.setCliContent('test-sess', 'some output');
      hub.setHubView('cli');
      await hub.render({ forceNew: true });

      const opts = api.calls.filter(c => c.method === 'sendMessage')[0]?.args[2] as any;
      const keyboard = opts.reply_markup.inline_keyboard;

      // Flatten all callback_data values
      const allData = keyboard.flat().map((b: any) => b.callback_data);

      // Should have CLI action buttons
      assert.ok(allData.includes('action:scroll-up'), 'should have scroll up');
      assert.ok(allData.includes('action:scroll-down'), 'should have scroll down');
      assert.ok(allData.includes('action:enter'), 'should have enter');
      assert.ok(allData.includes('action:escape'), 'should have escape');
      assert.ok(allData.includes('action:arrow-up'), 'should have arrow up');
      assert.ok(allData.includes('action:arrow-down'), 'should have arrow down');
      assert.ok(allData.includes('action:arrow-left'), 'should have arrow left');
      assert.ok(allData.includes('action:arrow-right'), 'should have arrow right');
      assert.ok(allData.includes('action:backspace'), 'should have backspace');
      assert.ok(allData.includes('action:clear-input'), 'should have clear input');
      assert.ok(allData.includes('action:clear'), 'should have clear');

      // Should have Back to Sessions button
      assert.ok(allData.includes('hub:cli-back'), 'should have Back to Sessions button with hub:cli-back');

      // Back to Sessions should be the last row
      const lastRow = keyboard[keyboard.length - 1];
      assert.ok(lastRow.some((b: any) => b.callback_data === 'hub:cli-back'), 'Back to Sessions should be in last row');
    });

    it('setCliContent stores and getCliContent retrieves correctly', () => {
      const api = createMockApi();
      const sm = createMockSessionManager([]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      // Before setting, should be null/empty
      const before = hub.getCliContent();
      assert.equal(before.sessionName, null, 'sessionName should be null initially');
      assert.equal(before.screenText, '', 'screenText should be empty initially');

      hub.setCliContent('alpha', 'screen output here');
      const after = hub.getCliContent();
      assert.equal(after.sessionName, 'alpha', 'sessionName should match');
      assert.equal(after.screenText, 'screen output here', 'screenText should match');
    });

    it('transitioning from cli to sessions and back preserves CLI content', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'sess-1', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'sess-1');

      // Set CLI content and render CLI view
      hub.setCliContent('sess-1', 'terminal stuff');
      hub.setHubView('cli');
      await hub.render({ forceNew: true });

      const cliText = api.calls.filter(c => c.method === 'sendMessage')[0]?.args[1] as string;
      assert.ok(cliText.includes('terminal stuff'), 'CLI view should show terminal content');

      // Switch to sessions
      hub.setHubView('sessions');
      api.calls.length = 0;
      await hub.render({ forceNew: true });

      const sessText = api.calls.filter(c => c.method === 'sendMessage')[0]?.args[1] as string;
      assert.ok(sessText.includes('Sessions Hub'), 'sessions view should show Sessions Hub');

      // Switch back to CLI -- content should be preserved
      hub.setHubView('cli');
      api.calls.length = 0;
      await hub.render({ forceNew: true });

      const cliText2 = api.calls.filter(c => c.method === 'sendMessage')[0]?.args[1] as string;
      assert.ok(cliText2.includes('terminal stuff'), 'CLI content should be preserved after view transition');
    });

    it('CLI view text uses wrapPre for terminal content', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'html-test', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'html-test');

      // Test HTML escaping via wrapPre
      hub.setCliContent('html-test', 'if (x < 10 && y > 5) {}');
      hub.setHubView('cli');
      await hub.render({ forceNew: true });

      const sentText = api.calls.filter(c => c.method === 'sendMessage')[0]?.args[1] as string;
      // wrapPre escapes HTML, so < becomes &lt; and > becomes &gt; and & becomes &amp;
      assert.ok(sentText.includes('&lt;'), 'should HTML-escape < character');
      assert.ok(sentText.includes('&gt;'), 'should HTML-escape > character');
      assert.ok(sentText.includes('&amp;'), 'should HTML-escape & character');
      assert.ok(!sentText.includes('< 10'), 'should NOT have raw < in output');
    });
  });

  describe('CLI view keyboard', () => {
    it('CLI view keyboard includes Back to Sessions button with hub:cli-back data', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'test-sess', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'test-sess');

      hub.setCliContent('test-sess', 'some terminal output');
      hub.setHubView('cli');
      await hub.render({ forceNew: true });

      const sendCall = api.calls.find(c => c.method === 'sendMessage');
      assert.ok(sendCall, 'should have sent a message');
      const opts = sendCall!.args[2] as { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
      assert.ok(opts?.reply_markup?.inline_keyboard, 'should have inline keyboard');

      // Find the Back to Sessions button
      const allButtons = opts.reply_markup!.inline_keyboard.flat();
      const backButton = allButtons.find(b => b.callback_data === 'hub:cli-back');
      assert.ok(backButton, 'should have hub:cli-back button');
      assert.ok(backButton!.text.includes('Back to Sessions'), 'button text should include Back to Sessions');
    });

    it('CLI view keyboard includes scroll, arrow, and action buttons', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'test-sess', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'test-sess');

      hub.setCliContent('test-sess', 'terminal content');
      hub.setHubView('cli');
      await hub.render({ forceNew: true });

      const sendCall = api.calls.find(c => c.method === 'sendMessage');
      const opts = sendCall!.args[2] as { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
      const allButtons = opts!.reply_markup!.inline_keyboard.flat();
      const buttonDatas = allButtons.map(b => b.callback_data);

      // Verify key button callback_data values are present
      assert.ok(buttonDatas.includes('action:scroll-up'), 'should have scroll-up');
      assert.ok(buttonDatas.includes('action:scroll-down'), 'should have scroll-down');
      assert.ok(buttonDatas.includes('action:scroll-lock'), 'should have scroll-lock');
      assert.ok(buttonDatas.includes('action:enter'), 'should have enter');
      assert.ok(buttonDatas.includes('action:escape'), 'should have escape');
      assert.ok(buttonDatas.includes('action:arrow-up'), 'should have arrow-up');
      assert.ok(buttonDatas.includes('action:arrow-down'), 'should have arrow-down');
      assert.ok(buttonDatas.includes('hub:cli-back'), 'should have cli-back');
    });

    it('setting CLI content and rendering produces correct HTML output', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'my-session', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'my-session');

      hub.setCliContent('my-session', 'hello world');
      hub.setHubView('cli');
      await hub.render({ forceNew: true });

      const sendCall = api.calls.find(c => c.method === 'sendMessage');
      const text = sendCall!.args[1] as string;
      assert.ok(text.includes('hello world'), 'should contain CLI screen text');
      assert.ok(text.includes('CLI of my-session'), 'should contain session name header');
      assert.ok(text.includes('<pre>'), 'should wrap in pre tag');
    });
  });

  describe('rate limiting', () => {
    function createMockRateLimiter(canSendResult: boolean) {
      const calls: { method: string; args?: unknown[] }[] = [];
      return {
        canSend(mandatory: boolean): boolean {
          calls.push({ method: 'canSend', args: [mandatory] });
          return mandatory ? true : canSendResult;
        },
        recordSend(): void {
          calls.push({ method: 'recordSend' });
        },
        calls,
      };
    }

    it('render({ mandatory: true }) always calls sendMessage', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([{ name: 'a', status: 'running' }]);
      const rl = createMockRateLimiter(false); // deferrable would be blocked
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'a', undefined, undefined, undefined, rl);

      await hub.render({ mandatory: true });

      const sends = api.calls.filter(c => c.method === 'sendMessage');
      assert.equal(sends.length, 1, 'mandatory render should call sendMessage');
    });

    it('render() with no opts defaults to mandatory=true and calls API', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([{ name: 'a', status: 'running' }]);
      const rl = createMockRateLimiter(false); // deferrable would be blocked
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'a', undefined, undefined, undefined, rl);

      await hub.render(); // no opts -- should default to mandatory=true

      const sends = api.calls.filter(c => c.method === 'sendMessage');
      assert.equal(sends.length, 1, 'default render should call sendMessage (mandatory by default)');
    });

    it('render({ mandatory: false }) is skipped when rate limiter says canSend=false', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([{ name: 'a', status: 'running' }]);
      const rl = createMockRateLimiter(false); // block deferrable
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'a', undefined, undefined, undefined, rl);

      await hub.render({ mandatory: false });

      const sends = api.calls.filter(c => c.method === 'sendMessage');
      assert.equal(sends.length, 0, 'deferrable render should be skipped when rate limited');
    });

    it('render({ mandatory: false }) proceeds when rate limiter says canSend=true', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([{ name: 'a', status: 'running' }]);
      const rl = createMockRateLimiter(true); // allow deferrable
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'a', undefined, undefined, undefined, rl);

      await hub.render({ mandatory: false });

      const sends = api.calls.filter(c => c.method === 'sendMessage');
      assert.equal(sends.length, 1, 'deferrable render should proceed when rate limiter allows');
    });

    it('successful sendMessage calls recordSend on the rate limiter', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([{ name: 'a', status: 'running' }]);
      const rl = createMockRateLimiter(true);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'a', undefined, undefined, undefined, rl);

      await hub.render({ mandatory: true });

      const recordCalls = rl.calls.filter(c => c.method === 'recordSend');
      assert.equal(recordCalls.length, 1, 'should call recordSend after successful sendMessage');
    });

    it('successful editMessageText calls recordSend on the rate limiter', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'a', status: 'running' },
        { name: 'b', status: 'running' },
      ]);
      const rl = createMockRateLimiter(true);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'a', undefined, undefined, undefined, rl);

      // First render: sendMessage (creates hub message)
      await hub.render({ mandatory: true });
      rl.calls.length = 0; // reset tracked calls

      // Second render with different data: editMessageText
      await hub.render({ mandatory: true });

      const recordCalls = rl.calls.filter(c => c.method === 'recordSend');
      assert.equal(recordCalls.length, 1, 'should call recordSend after successful editMessageText');
    });

    it('debouncedRender passes mandatory=false to render', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([{ name: 'a', status: 'running' }]);
      const rl = createMockRateLimiter(false); // block deferrable
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'a', undefined, undefined, undefined, rl);

      hub.debouncedRender(10); // short delay for testing

      // Wait for debounce to fire
      await new Promise(resolve => setTimeout(resolve, 50));

      // Since deferrable is blocked, sendMessage should NOT be called
      const sends = api.calls.filter(c => c.method === 'sendMessage');
      assert.equal(sends.length, 0, 'debouncedRender should pass mandatory=false (and be blocked by rate limiter)');
    });

    it('works without rate limiter (backward compat)', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([{ name: 'a', status: 'running' }]);
      // No rate limiter passed -- all sends should go through
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'a');

      await hub.render({ mandatory: false });

      const sends = api.calls.filter(c => c.method === 'sendMessage');
      assert.equal(sends.length, 1, 'without rate limiter, all renders should proceed');
    });
  });

  describe('Resume button in sessions view', () => {
    it('sessions keyboard includes Resume button with hub:cli-resume when activeSession is set', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'my-project', status: 'running' },
        { name: 'other', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'my-project');

      // Render in sessions view (default)
      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      const allButtons = keyboard!.flat();
      const resumeButton = allButtons.find(b => b.callback_data === 'hub:cli-resume');
      assert.ok(resumeButton, 'should have hub:cli-resume button when activeSession is set');
      assert.ok(resumeButton!.text.includes('my-project'), 'Resume button text should include session name');
      assert.ok(!resumeButton!.text.includes('Resume'), 'Resume button should NOT contain word Resume');
    });

    it('sessions keyboard does NOT include Resume button when activeSession is null', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'proj-a', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => null);

      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      const allButtons = keyboard!.flat();
      const resumeButton = allButtons.find(b => b.callback_data === 'hub:cli-resume');
      assert.ok(!resumeButton, 'should NOT have hub:cli-resume button when activeSession is null');
    });

    it('Resume button shares row with kill button for the active session', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'sess-1', status: 'running' },
        { name: 'sess-2', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'sess-1');

      await hub.render();

      const opts = api.calls[0].args[2] as { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
      const keyboard = opts?.reply_markup?.inline_keyboard;
      assert.ok(keyboard, 'should have inline keyboard');

      // Find the row containing the resume button
      const resumeRow = keyboard!.find(row =>
        row.some(b => b.callback_data === 'hub:cli-resume')
      );
      assert.ok(resumeRow, 'should find row with resume button');

      // Same row should also have the kill button for sess-1
      const killButton = resumeRow!.find(b => b.callback_data === 'hub:disconnect:sess-1');
      assert.ok(killButton, 'Resume and kill button should be in the same row');

      // Resume should be first (left), kill second (right)
      const resumeIdx = resumeRow!.findIndex(b => b.callback_data === 'hub:cli-resume');
      const killIdx = resumeRow!.findIndex(b => b.callback_data === 'hub:disconnect:sess-1');
      assert.ok(resumeIdx < killIdx, 'Resume button should be to the left of kill button');
    });

    it('clicking hub:cli-resume transitions hub view to cli', async () => {
      const api = createMockApi();
      const sm = createMockSessionManager([
        { name: 'test-sess', status: 'running' },
      ]);
      const hub = new HubRenderer(api as any, 123, sm as any, () => 'test-sess');

      // Set some CLI content first (simulates previous CLI view visit)
      hub.setCliContent('test-sess', 'prior terminal output');

      // Start in sessions view
      hub.setHubView('sessions');
      await hub.render();

      // Simulate clicking Resume by setting hub view to 'cli'
      hub.setHubView('cli');
      assert.equal(hub.hubView, 'cli', 'hub view should transition to cli');

      // Render the CLI view and verify content is preserved
      api.calls.length = 0;
      await hub.render({ forceNew: true });

      const sentText = api.calls.filter(c => c.method === 'sendMessage')[0]?.args[1] as string;
      assert.ok(sentText.includes('prior terminal output'), 'CLI content should be preserved after resume');
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
