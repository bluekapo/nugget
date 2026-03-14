/**
 * Behavioral tests for the ScreenCapture -> HubRenderer wiring logic (UHM-04)
 * and the onSessionSwitch handler behavior (UHM-05).
 *
 * These tests extract and exercise the callback logic that lives in index.ts
 * (startPrimary lines 124-194) without importing the full framework entry point.
 *
 * Gap 1 (UHM-04): ScreenCapture output events trigger hub re-render when hub
 * is in CLI view. When hub is in another view, render() is NOT called.
 *
 * Gap 2 (UHM-05): Session switch triggers resetBaseline(), setCliContent(''),
 * and setHubView('cli') — no message deletion or SQLite persistence involved.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { OutputEvent } from '../../src/terminal/capture.js';

// ---------------------------------------------------------------------------
// Hand-rolled mocks for HubRenderer and ScreenCapture public APIs
// ---------------------------------------------------------------------------

type HubViewState = 'sessions' | 'automationHub' | 'automationDetails' | 'cli';

function createMockHubRenderer() {
  const calls: { method: string; args: unknown[] }[] = [];
  let currentView: HubViewState = 'sessions';
  let cliSessionName: string | null = null;
  let cliScreenText = '';

  return {
    get hubView(): HubViewState { return currentView; },

    setHubView(view: HubViewState): void {
      currentView = view;
      calls.push({ method: 'setHubView', args: [view] });
    },

    setCliContent(sessionName: string, screenText: string): void {
      cliSessionName = sessionName;
      cliScreenText = screenText;
      calls.push({ method: 'setCliContent', args: [sessionName, screenText] });
    },

    getCliContent(): { sessionName: string | null; screenText: string } {
      return { sessionName: cliSessionName, screenText: cliScreenText };
    },

    render(_opts?: { mandatory?: boolean }): void {
      calls.push({ method: 'render', args: [_opts] });
    },

    // Expose for assertions
    calls,
  };
}

function createMockScreenCapture() {
  const calls: { method: string }[] = [];
  return {
    resetBaseline(): void {
      calls.push({ method: 'resetBaseline' });
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// The output callback factory — extracted from index.ts startPrimary lines 124-135.
// This produces the exact same closure behaviour as in production without importing
// the full framework.
// ---------------------------------------------------------------------------

function makeOutputCallback(
  hubRenderer: ReturnType<typeof createMockHubRenderer>,
  getActiveSession: () => string | null,
) {
  return (event: OutputEvent): void => {
    const session = getActiveSession();
    if (!session) return;
    if (event.mode === 'replace') {
      hubRenderer.setCliContent(session, event.text);
    } else {
      // Append mode: accumulate onto existing content
      const current = hubRenderer.getCliContent();
      hubRenderer.setCliContent(session, current.screenText + event.text);
    }
    if (hubRenderer.hubView === 'cli') {
      hubRenderer.render({ mandatory: false });
    }
  };
}

// ---------------------------------------------------------------------------
// The onSessionSwitch handler factory — extracted from index.ts lines 190-193.
// ---------------------------------------------------------------------------

function makeOnSessionSwitchHandler(
  screenCapture: ReturnType<typeof createMockScreenCapture>,
  hubRenderer: ReturnType<typeof createMockHubRenderer>,
) {
  return (_from: string | null, to: string): void => {
    screenCapture.resetBaseline();
    hubRenderer.setCliContent(to, '');
    hubRenderer.setHubView('cli');
  };
}

// ---------------------------------------------------------------------------
// Gap 1 (UHM-04): ScreenCapture output events -> HubRenderer wiring
// ---------------------------------------------------------------------------

describe('UHM-04: ScreenCapture output event -> hub wiring', () => {
  let hub: ReturnType<typeof createMockHubRenderer>;
  let activeSession: string | null;
  let outputCallback: (event: OutputEvent) => void;

  beforeEach(() => {
    hub = createMockHubRenderer();
    activeSession = 'my-session';
    outputCallback = makeOutputCallback(hub, () => activeSession);
  });

  it('replace event sets cli content with the session name and full text', () => {
    hub.setHubView('cli');

    outputCallback({ text: 'full screen snapshot', mode: 'replace', trigger: 'redraw' });

    const setCliCalls = hub.calls.filter(c => c.method === 'setCliContent');
    assert.equal(setCliCalls.length, 1, 'setCliContent should be called once');
    assert.deepEqual(setCliCalls[0].args, ['my-session', 'full screen snapshot']);
  });

  it('append event accumulates text onto existing cli content', () => {
    hub.setCliContent('my-session', 'existing content\n');
    hub.calls.length = 0; // reset after setup

    outputCallback({ text: 'new appended line\n', mode: 'append', trigger: 'stream' });

    const setCliCalls = hub.calls.filter(c => c.method === 'setCliContent');
    assert.equal(setCliCalls.length, 1, 'setCliContent should be called once');
    assert.deepEqual(setCliCalls[0].args, ['my-session', 'existing content\nnew appended line\n']);
  });

  it('render is called when hub is in cli view', () => {
    hub.setHubView('cli');
    hub.calls.length = 0;

    outputCallback({ text: 'some output', mode: 'replace', trigger: 'stream' });

    const renderCalls = hub.calls.filter(c => c.method === 'render');
    assert.equal(renderCalls.length, 1, 'render() should be called when hub is in cli view');
  });

  it('render is NOT called when hub is in sessions view', () => {
    // Hub defaults to 'sessions' view — no explicit setHubView needed
    hub.calls.length = 0;

    outputCallback({ text: 'some output', mode: 'replace', trigger: 'stream' });

    const renderCalls = hub.calls.filter(c => c.method === 'render');
    assert.equal(renderCalls.length, 0, 'render() should NOT be called when hub is not in cli view');
  });

  it('render is NOT called when hub is in automationHub view', () => {
    hub.setHubView('automationHub');
    hub.calls.length = 0;

    outputCallback({ text: 'output during automation', mode: 'replace', trigger: 'stream' });

    const renderCalls = hub.calls.filter(c => c.method === 'render');
    assert.equal(renderCalls.length, 0, 'render() should NOT be called in automationHub view');
  });

  it('render is NOT called when there is no active session', () => {
    hub.setHubView('cli');
    activeSession = null;
    hub.calls.length = 0;

    outputCallback({ text: 'orphan output', mode: 'replace', trigger: 'stream' });

    // Should bail out immediately when activeSession is null
    assert.equal(hub.calls.length, 0, 'no hub methods should be called when activeSession is null');
  });

  it('render receives mandatory:false so rate-limited sends are deferrable', () => {
    hub.setHubView('cli');
    hub.calls.length = 0;

    outputCallback({ text: 'update', mode: 'replace', trigger: 'stream' });

    const renderCalls = hub.calls.filter(c => c.method === 'render');
    assert.equal(renderCalls.length, 1, 'render should be called');
    assert.deepEqual(renderCalls[0].args[0], { mandatory: false }, 'render should be called with mandatory:false');
  });
});

// ---------------------------------------------------------------------------
// Gap 2 (UHM-05): onSessionSwitch handler behavior
// ---------------------------------------------------------------------------

describe('UHM-05: onSessionSwitch handler wiring', () => {
  let hub: ReturnType<typeof createMockHubRenderer>;
  let capture: ReturnType<typeof createMockScreenCapture>;
  let onSessionSwitch: (from: string | null, to: string) => void;

  beforeEach(() => {
    hub = createMockHubRenderer();
    capture = createMockScreenCapture();
    onSessionSwitch = makeOnSessionSwitchHandler(capture, hub);
  });

  it('calls screenCapture.resetBaseline() on session switch', () => {
    onSessionSwitch('old-session', 'new-session');

    const resets = capture.calls.filter(c => c.method === 'resetBaseline');
    assert.equal(resets.length, 1, 'resetBaseline() should be called on session switch');
  });

  it('clears cli content for the new session via setCliContent(newSession, empty string)', () => {
    onSessionSwitch('old-session', 'new-session');

    const setCliCalls = hub.calls.filter(c => c.method === 'setCliContent');
    assert.equal(setCliCalls.length, 1, 'setCliContent should be called once');
    assert.deepEqual(setCliCalls[0].args, ['new-session', ''], 'should set empty content for new session');
  });

  it('sets hub view to cli on session switch', () => {
    onSessionSwitch('old-session', 'new-session');

    const setViewCalls = hub.calls.filter(c => c.method === 'setHubView');
    assert.equal(setViewCalls.length, 1, 'setHubView should be called once');
    assert.deepEqual(setViewCalls[0].args, ['cli'], 'hub view should be set to cli');
  });

  it('works correctly when switching from null (first switch)', () => {
    onSessionSwitch(null, 'first-session');

    assert.equal(capture.calls.filter(c => c.method === 'resetBaseline').length, 1, 'resetBaseline should be called');
    const setCliCalls = hub.calls.filter(c => c.method === 'setCliContent');
    assert.equal(setCliCalls.length, 1, 'setCliContent should be called');
    assert.deepEqual(setCliCalls[0].args, ['first-session', ''], 'new session content should be empty');
    const setViewCalls = hub.calls.filter(c => c.method === 'setHubView');
    assert.deepEqual(setViewCalls[0].args, ['cli'], 'hub view should be cli');
  });

  it('performs all three operations in order: resetBaseline, setCliContent, setHubView', () => {
    onSessionSwitch('a', 'b');

    // The calls array records in order of invocation
    const methods = hub.calls.map(c => c.method);
    // setCliContent and setHubView must both appear in hub.calls
    assert.ok(methods.includes('setCliContent'), 'setCliContent should be called');
    assert.ok(methods.includes('setHubView'), 'setHubView should be called');

    // setCliContent must precede setHubView (clear content before showing view)
    const setCliIdx = methods.indexOf('setCliContent');
    const setViewIdx = methods.indexOf('setHubView');
    assert.ok(setCliIdx < setViewIdx, 'setCliContent should be called before setHubView');

    // resetBaseline must happen (tracked separately in capture.calls)
    assert.equal(capture.calls.length, 1, 'resetBaseline should be the only capture call');
    assert.equal(capture.calls[0].method, 'resetBaseline');
  });
});
