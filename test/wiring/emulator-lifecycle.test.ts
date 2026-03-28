/**
 * Behavioral tests for per-session emulator lifecycle management:
 *
 * EMUL-02: Non-active session PTY output accumulates in that session's emulator
 *          and is readable after switching to it.
 * EMUL-03: SIGWINCH resizes ALL session emulators, not just the active one.
 * EMUL-04: Session exit disposes the associated emulator and removes it from the Map.
 *
 * These tests extract callback factories mirroring the production wiring in
 * index.ts (startPrimary) and exercise them with real TerminalEmulator instances
 * (EMUL-02) or lightweight spy wrappers (EMUL-03, EMUL-04).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalEmulator } from '../../src/terminal/emulator.js';

// ---------------------------------------------------------------------------
// Callback factory: session:output routing (mirrors index.ts startPrimary)
//
//   bus.on('session:output', (name, data) => {
//     if (router.activeSession === name) {
//       screenCapture.onData(data);
//     } else {
//       const emu = emulators.get(name);
//       if (emu) { emu.write(data); }
//     }
//   });
// ---------------------------------------------------------------------------

function makeSessionOutputHandler(
  screenCapture: { onData(data: string): void },
  emulators: Map<string, TerminalEmulator>,
  getActiveSession: () => string | null,
) {
  return (name: string, data: string): void => {
    if (getActiveSession() === name) {
      screenCapture.onData(data);
    } else {
      const emu = emulators.get(name);
      if (emu) {
        emu.write(data);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Callback factory: SIGWINCH resize all emulators (mirrors index.ts startPrimary)
//
//   const sigwinchHandler = () => {
//     const cols = process.stdout.columns;
//     const rows = process.stdout.rows;
//     if (cols && rows) {
//       try {
//         sessionManager.resizeSession(sessionName, cols, rows);
//         for (const emu of emulators.values()) {
//           emu.resize(cols, rows);
//         }
//       } catch { }
//     }
//   };
// ---------------------------------------------------------------------------

interface ResizableEmulator {
  resize(cols: number, rows: number): void;
  cols: number;
  rows: number;
}

function makeSigwinchHandler(
  emulators: Map<string, ResizableEmulator>,
  getTermSize: () => { cols: number | undefined; rows: number | undefined },
  resizeSession: (cols: number, rows: number) => void,
) {
  return (): void => {
    const { cols, rows } = getTermSize();
    if (cols && rows) {
      try {
        resizeSession(cols, rows);
        for (const emu of emulators.values()) {
          emu.resize(cols, rows);
        }
      } catch { /* swallow */ }
    }
  };
}

// ---------------------------------------------------------------------------
// Callback factory: session:exit emulator disposal (mirrors index.ts startPrimary)
//
//   bus.on('session:exit', (name) => {
//     const wasActive = router.activeSession === name;
//     router.remove(name);
//     hubRenderer.clearExecState(name);
//     completionTracker.removeSession(name);
//     const emu = emulators.get(name);
//     if (emu) {
//       emu.dispose();
//       emulators.delete(name);
//     }
//   });
// ---------------------------------------------------------------------------

function makeSessionExitHandler(
  emulators: Map<string, TerminalEmulator>,
) {
  return (name: string): void => {
    const emu = emulators.get(name);
    if (emu) {
      emu.dispose();
      emulators.delete(name);
    }
  };
}

// ===========================================================================
// EMUL-02: Background emulator accumulation
// ===========================================================================

describe('EMUL-02: background emulator accumulation', () => {
  let emulators: Map<string, TerminalEmulator>;
  let activeSession: string;
  let onDataCalls: string[];
  let onSessionOutput: (name: string, data: string) => void;

  beforeEach(() => {
    emulators = new Map();
    activeSession = 'session-a';
    onDataCalls = [];
    onSessionOutput = makeSessionOutputHandler(
      { onData(data: string) { onDataCalls.push(data); } },
      emulators,
      () => activeSession,
    );
  });

  it('non-active session PTY data written to its emulator is readable via getScreenText()', async () => {
    const emuB = new TerminalEmulator(80, 24);
    emulators.set('session-b', emuB);

    // session-a is active, so session-b data goes to its emulator
    onSessionOutput('session-b', 'hello from background');

    // Allow the async write to settle
    await new Promise(resolve => setTimeout(resolve, 50));

    const text = emuB.getScreenText();
    assert.ok(text.includes('hello from background'), `expected screen text to contain 'hello from background', got: ${text}`);
    emuB.dispose();
  });

  it('multiple chunks accumulate correctly in a background emulator', async () => {
    const emuB = new TerminalEmulator(80, 24);
    emulators.set('session-b', emuB);

    onSessionOutput('session-b', 'chunk-1\r\n');
    onSessionOutput('session-b', 'chunk-2\r\n');
    onSessionOutput('session-b', 'chunk-3\r\n');

    await new Promise(resolve => setTimeout(resolve, 50));

    const text = emuB.getScreenText();
    assert.ok(text.includes('chunk-1'), `missing chunk-1 in: ${text}`);
    assert.ok(text.includes('chunk-2'), `missing chunk-2 in: ${text}`);
    assert.ok(text.includes('chunk-3'), `missing chunk-3 in: ${text}`);
    emuB.dispose();
  });

  it('after switching active session, previously-background emulator still contains accumulated data', async () => {
    const emuB = new TerminalEmulator(80, 24);
    emulators.set('session-b', emuB);

    // Write data while session-b is in background
    onSessionOutput('session-b', 'background data\r\n');
    await new Promise(resolve => setTimeout(resolve, 50));

    // Switch active session to session-b
    activeSession = 'session-b';

    // Data accumulated before the switch must still be readable
    const text = emuB.getScreenText();
    assert.ok(text.includes('background data'), `accumulated data should persist after switch, got: ${text}`);
    emuB.dispose();
  });

  it('two non-active sessions accumulate independently in their own real emulators', async () => {
    const emuB = new TerminalEmulator(80, 24);
    const emuC = new TerminalEmulator(80, 24);
    emulators.set('session-b', emuB);
    emulators.set('session-c', emuC);

    onSessionOutput('session-b', 'data-for-b\r\n');
    onSessionOutput('session-c', 'data-for-c\r\n');

    await new Promise(resolve => setTimeout(resolve, 50));

    const textB = emuB.getScreenText();
    const textC = emuC.getScreenText();
    assert.ok(textB.includes('data-for-b'), `session-b should have its own data, got: ${textB}`);
    assert.ok(!textB.includes('data-for-c'), `session-b should NOT have session-c data, got: ${textB}`);
    assert.ok(textC.includes('data-for-c'), `session-c should have its own data, got: ${textC}`);
    assert.ok(!textC.includes('data-for-b'), `session-c should NOT have session-b data, got: ${textC}`);

    emuB.dispose();
    emuC.dispose();
  });
});

// ===========================================================================
// EMUL-03: SIGWINCH resize propagation
// ===========================================================================

describe('EMUL-03: SIGWINCH resize propagation', () => {
  it('resize propagates to all emulators in the Map', () => {
    const emulators = new Map<string, ResizableEmulator>();
    const emu1 = new TerminalEmulator(80, 24);
    const emu2 = new TerminalEmulator(80, 24);
    const emu3 = new TerminalEmulator(80, 24);
    emulators.set('s1', emu1);
    emulators.set('s2', emu2);
    emulators.set('s3', emu3);

    const resizeCalls: Array<[number, number]> = [];
    const handler = makeSigwinchHandler(
      emulators,
      () => ({ cols: 132, rows: 50 }),
      (cols, rows) => { resizeCalls.push([cols, rows]); },
    );

    handler();

    assert.equal(emu1.cols, 132, 'emu1 cols should be 132');
    assert.equal(emu1.rows, 50, 'emu1 rows should be 50');
    assert.equal(emu2.cols, 132, 'emu2 cols should be 132');
    assert.equal(emu2.rows, 50, 'emu2 rows should be 50');
    assert.equal(emu3.cols, 132, 'emu3 cols should be 132');
    assert.equal(emu3.rows, 50, 'emu3 rows should be 50');
    assert.equal(resizeCalls.length, 1, 'resizeSession should be called once');

    emu1.dispose();
    emu2.dispose();
    emu3.dispose();
  });

  it('resize updates emulators added after handler creation', () => {
    const emulators = new Map<string, ResizableEmulator>();
    const emu1 = new TerminalEmulator(80, 24);
    emulators.set('s1', emu1);

    const handler = makeSigwinchHandler(
      emulators,
      () => ({ cols: 100, rows: 30 }),
      () => {},
    );

    // Add a new emulator AFTER handler was created
    const emu2 = new TerminalEmulator(80, 24);
    emulators.set('s2', emu2);

    handler();

    assert.equal(emu1.cols, 100, 'pre-existing emulator should be resized');
    assert.equal(emu1.rows, 30);
    assert.equal(emu2.cols, 100, 'newly added emulator should also be resized');
    assert.equal(emu2.rows, 30);

    emu1.dispose();
    emu2.dispose();
  });

  it('empty emulators Map does not throw on resize', () => {
    const emulators = new Map<string, ResizableEmulator>();
    const handler = makeSigwinchHandler(
      emulators,
      () => ({ cols: 120, rows: 40 }),
      () => {},
    );

    assert.doesNotThrow(() => handler(), 'handler should not throw with empty emulators Map');
  });
});

// ===========================================================================
// EMUL-04: session:exit emulator disposal
// ===========================================================================

describe('EMUL-04: session:exit emulator disposal', () => {
  let emulators: Map<string, TerminalEmulator>;
  let onSessionExit: (name: string) => void;

  beforeEach(() => {
    emulators = new Map();
    onSessionExit = makeSessionExitHandler(emulators);
  });

  it('emulator is removed from Map after session:exit fires', () => {
    const emu = new TerminalEmulator(80, 24);
    emulators.set('dying-session', emu);
    assert.equal(emulators.size, 1);

    onSessionExit('dying-session');

    assert.equal(emulators.has('dying-session'), false, 'emulator should be removed from Map');
    assert.equal(emulators.size, 0, 'Map should be empty');
  });

  it('emulator.dispose() is called on exit (spy wrapper)', () => {
    const emu = new TerminalEmulator(80, 24);
    let disposeCalled = false;

    // Wrap dispose with a spy
    const originalDispose = emu.dispose.bind(emu);
    emu.dispose = () => {
      disposeCalled = true;
      originalDispose();
    };

    emulators.set('session-x', emu);
    onSessionExit('session-x');

    assert.equal(disposeCalled, true, 'dispose() should be called on the emulator');
  });

  it('session:exit for a session with no emulator does not throw', () => {
    // No emulator registered for 'ghost-session'
    assert.doesNotThrow(() => {
      onSessionExit('ghost-session');
    }, 'handler should not throw when no emulator exists for the session');
  });

  it('after disposal, Map size decreases by 1', () => {
    const emuA = new TerminalEmulator(80, 24);
    const emuB = new TerminalEmulator(80, 24);
    emulators.set('session-a', emuA);
    emulators.set('session-b', emuB);
    assert.equal(emulators.size, 2);

    onSessionExit('session-a');

    assert.equal(emulators.size, 1, 'Map size should decrease by 1');
    assert.equal(emulators.has('session-a'), false, 'disposed session should be gone');
    assert.equal(emulators.has('session-b'), true, 'other session should remain');

    // Clean up
    emuB.dispose();
  });
});
