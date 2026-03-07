import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalEmulator } from '../../src/terminal/emulator.js';
import { TERMINAL_COLS, TERMINAL_ROWS } from '../../src/terminal/constants.js';

describe('TerminalEmulator', () => {
  let emulator: TerminalEmulator;

  afterEach(() => {
    emulator?.dispose();
  });

  it('write() plain text -> getScreenText() returns that text', async () => {
    emulator = new TerminalEmulator();
    await emulator.write('hello world');
    const text = emulator.getScreenText();
    assert.ok(text.includes('hello world'), `Expected "hello world" in: "${text}"`);
  });

  it('write() text with ANSI color codes -> getScreenText() returns plain text', async () => {
    emulator = new TerminalEmulator();
    await emulator.write('\x1b[31mred text\x1b[0m');
    const text = emulator.getScreenText();
    assert.ok(text.includes('red text'), `Expected "red text" in: "${text}"`);
    assert.ok(!text.includes('\x1b'), 'Should not contain escape sequences');
  });

  it('write() cursor movement sequences -> text appears at correct positions', async () => {
    emulator = new TerminalEmulator();
    // Move cursor to row 3, col 5 (1-indexed) and write text
    await emulator.write('\x1b[3;5Hhello');
    const text = emulator.getScreenText();
    const lines = text.split('\n');
    // Row 3 = index 2
    assert.ok(lines.length >= 3, `Expected at least 3 lines, got ${lines.length}`);
    assert.ok(lines[2].includes('hello'), `Expected "hello" in line 3: "${lines[2]}"`);
  });

  it('multiple sequential write() calls -> state persists', async () => {
    emulator = new TerminalEmulator();
    await emulator.write('line one');
    await emulator.write('\nline two');
    const text = emulator.getScreenText();
    assert.ok(text.includes('line one'), 'Should contain first write');
    assert.ok(text.includes('line two'), 'Should contain second write');
  });

  it('partial escape sequence split across two write() calls -> correctly reassembled', async () => {
    emulator = new TerminalEmulator();
    // Split \x1b[31m (red) across two writes
    await emulator.write('before\x1b[3');
    await emulator.write('1mafter\x1b[0m');
    const text = emulator.getScreenText();
    assert.ok(text.includes('before'), 'Should contain text before escape');
    assert.ok(text.includes('after'), 'Should contain text after escape');
    assert.ok(!text.includes('\x1b'), 'Should not contain raw escape chars');
  });

  it('isAltScreen() returns false by default, true after enter, false after exit', async () => {
    emulator = new TerminalEmulator();
    assert.equal(emulator.isAltScreen(), false, 'Default should be normal screen');
    await emulator.write('\x1b[?1049h');
    assert.equal(emulator.isAltScreen(), true, 'Should be alt screen after enter');
    await emulator.write('\x1b[?1049l');
    assert.equal(emulator.isAltScreen(), false, 'Should be normal screen after exit');
  });

  it('resize() changes dimensions -> text wraps at new column width', async () => {
    emulator = new TerminalEmulator(10, 5);
    await emulator.write('abcdefghijklmno'); // 15 chars in a 10-col terminal
    const text = emulator.getScreenText();
    const lines = text.split('\n');
    assert.ok(lines.length >= 2, `Expected wrapping, got ${lines.length} lines`);
    assert.equal(lines[0].length, 10, 'First line should be 10 chars');

    emulator.resize(20, 5);
    assert.equal(emulator.cols, 20, 'Cols should update after resize');
  });

  it('constructor uses TERMINAL_COLS/TERMINAL_ROWS from constants as defaults', () => {
    emulator = new TerminalEmulator();
    assert.equal(emulator.cols, TERMINAL_COLS);
    assert.equal(emulator.rows, TERMINAL_ROWS);
  });

  it('getScreenText() trims trailing empty lines', async () => {
    emulator = new TerminalEmulator(80, 24);
    await emulator.write('hello');
    const text = emulator.getScreenText();
    // Should not have 23 trailing empty lines
    assert.ok(!text.endsWith('\n'), `Should not end with newline: "${text}"`);
    const lines = text.split('\n');
    assert.equal(lines.length, 1, `Expected 1 line, got ${lines.length}`);
  });

  it('dispose() cleans up without errors', () => {
    emulator = new TerminalEmulator();
    emulator.dispose();
    // Should not throw; mark as disposed so afterEach doesn't double-dispose
    emulator = undefined as unknown as TerminalEmulator;
  });

  it('onBufferChange fires callback with true on alt screen enter', async () => {
    emulator = new TerminalEmulator(80, 24);
    const calls: boolean[] = [];
    emulator.onBufferChange((isAlt) => calls.push(isAlt));

    await emulator.write('\x1b[?1049h');

    assert.equal(calls.length, 1, 'Should fire once');
    assert.equal(calls[0], true, 'Should report alt screen');
  });

  it('onBufferChange fires callback with false on alt screen exit', async () => {
    emulator = new TerminalEmulator(80, 24);
    const calls: boolean[] = [];
    emulator.onBufferChange((isAlt) => calls.push(isAlt));

    await emulator.write('\x1b[?1049h');
    await emulator.write('\x1b[?1049l');

    assert.equal(calls.length, 2, 'Should fire twice');
    assert.equal(calls[0], true, 'First call: alt screen enter');
    assert.equal(calls[1], false, 'Second call: alt screen exit');
  });

  it('onBufferChange dispose stops callbacks', async () => {
    emulator = new TerminalEmulator(80, 24);
    const calls: boolean[] = [];
    const sub = emulator.onBufferChange((isAlt) => calls.push(isAlt));

    await emulator.write('\x1b[?1049h');
    assert.equal(calls.length, 1, 'Should fire before dispose');

    sub.dispose();

    await emulator.write('\x1b[?1049l');
    assert.equal(calls.length, 1, 'Should NOT fire after dispose');
  });
});
