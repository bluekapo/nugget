import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirective } from '../../src/automation/directive-parser.js';

describe('parseDirective', () => {
  describe('COMMAND directive', () => {
    it('extracts command string from ● COMMAND: line', () => {
      const result = parseDirective('some output\n● COMMAND: npm test\n\n❯ ');
      assert.deepStrictEqual(result, { type: 'COMMAND', command: 'npm test' });
    });

    it('preserves special characters (pipes, flags) in command', () => {
      const result = parseDirective('output\n● COMMAND: git log --oneline | head -5\n\n❯ ');
      assert.deepStrictEqual(result, {
        type: 'COMMAND',
        command: 'git log --oneline | head -5',
      });
    });
  });

  describe('SELECT directive', () => {
    it('extracts 1-based option number', () => {
      const result = parseDirective('menu items\n● SELECT: 3\ndone');
      assert.deepStrictEqual(result, { type: 'SELECT', option: 3 });
    });

    it('returns null for option 0 (invalid)', () => {
      const result = parseDirective('menu items\n● SELECT: 0\ndone');
      assert.strictEqual(result, null);
    });
  });

  describe('ENTER directive', () => {
    it('returns ENTER type with no parameters', () => {
      const result = parseDirective('waiting for input\n● ENTER\nprompt');
      assert.deepStrictEqual(result, { type: 'ENTER' });
    });
  });

  describe('WAIT directive', () => {
    it('returns WAIT without delaySeconds when bare WAIT', () => {
      const result = parseDirective('processing\n● WAIT\nstill going');
      assert.deepStrictEqual(result, { type: 'WAIT' });
    });

    it('returns WAIT with delaySeconds when WAIT: N given', () => {
      const result = parseDirective('processing\n● WAIT: 30\nstill going');
      assert.deepStrictEqual(result, { type: 'WAIT', delaySeconds: 30 });
    });
  });

  describe('ESCALATE directive', () => {
    it('extracts reason string', () => {
      const result = parseDirective('output\n● ESCALATE: Task appears complete\n\n❯ ');
      assert.deepStrictEqual(result, {
        type: 'ESCALATE',
        reason: 'Task appears complete',
      });
    });
  });

  describe('no directive', () => {
    it('returns null when no valid directive present', () => {
      const result = parseDirective('just some terminal output\nno directives here');
      assert.strictEqual(result, null);
    });

    it('returns null for bare directives without ● prefix', () => {
      const result = parseDirective('COMMAND: npm test');
      assert.strictEqual(result, null);
    });
  });

  describe('ignores echoed prompt examples', () => {
    it('skips bare COMMAND in prompt echo, finds ● COMMAND response', () => {
      const screenText = [
        'Example correct response:',
        'COMMAND: Fix the bug in src/session/pty.ts where delete signals are not sent',
        'correctly',
        '',
        '● COMMAND: /gsd:quick Fix the actual bug',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.deepStrictEqual(result, { type: 'COMMAND', command: '/gsd:quick Fix the actual bug' });
    });

    it('returns null when only bare example exists (no response yet)', () => {
      const screenText = [
        'Example correct response:',
        'COMMAND: Fix the bug in src/session/pty.ts',
        '',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.strictEqual(result, null);
    });
  });

  describe('whitespace handling', () => {
    it('parses correctly with leading/trailing whitespace', () => {
      const result = parseDirective('  ● COMMAND: npm test  ');
      assert.deepStrictEqual(result, { type: 'COMMAND', command: 'npm test' });
    });
  });

  describe('Claude Code TUI bullet prefix', () => {
    it('strips ● prefix from COMMAND directive', () => {
      const result = parseDirective('● COMMAND: npm test');
      assert.deepStrictEqual(result, { type: 'COMMAND', command: 'npm test' });
    });

    it('strips ● prefix from ESCALATE directive', () => {
      const result = parseDirective('● ESCALATE: Task is complete');
      assert.deepStrictEqual(result, { type: 'ESCALATE', reason: 'Task is complete' });
    });

    it('strips ● prefix from SELECT directive', () => {
      const result = parseDirective('● SELECT: 2');
      assert.deepStrictEqual(result, { type: 'SELECT', option: 2 });
    });

    it('strips ● prefix from WAIT directive', () => {
      const result = parseDirective('● WAIT: 10');
      assert.deepStrictEqual(result, { type: 'WAIT', delaySeconds: 10 });
    });

    it('strips ● prefix from ENTER directive', () => {
      const result = parseDirective('● ENTER');
      assert.deepStrictEqual(result, { type: 'ENTER' });
    });

    it('handles ● with leading whitespace', () => {
      const result = parseDirective('  ● COMMAND: npm run build');
      assert.deepStrictEqual(result, { type: 'COMMAND', command: 'npm run build' });
    });
  });

  describe('empty/blank lines', () => {
    it('finds directive in text with blank lines between content', () => {
      const screenText = [
        'some output',
        '',
        '',
        '● ESCALATE: Something went wrong',
        '',
        '',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.deepStrictEqual(result, {
        type: 'ESCALATE',
        reason: 'Something went wrong',
      });
    });
  });

  describe('long COMMAND values', () => {
    it('preserves docker run command with flags, volumes, and quoted arguments', () => {
      const cmd = 'docker run --rm -v /tmp:/data -e FOO=bar ubuntu:22.04 bash -c "echo hello world"';
      const result = parseDirective(`output\n● COMMAND: ${cmd}\n\n❯ `);
      assert.deepStrictEqual(result, { type: 'COMMAND', command: cmd });
    });

    it('preserves chained commands with flags and coverage filter', () => {
      const cmd = 'npm run build && npm test -- --filter=auth --coverage';
      const result = parseDirective(`output\n● COMMAND: ${cmd}\n\n❯ `);
      assert.deepStrictEqual(result, { type: 'COMMAND', command: cmd });
    });

    it('preserves pipes with single quotes and awk expressions', () => {
      const cmd = "cat /etc/hosts | grep -v \"^#\" | awk '{print $2}' | sort -u";
      const result = parseDirective(`output\n● COMMAND: ${cmd}\n\n❯ `);
      assert.deepStrictEqual(result, { type: 'COMMAND', command: cmd });
    });
  });

  describe('multi-line wrapped COMMAND', () => {
    it('collects indented continuation lines into full command', () => {
      const screenText = [
        '● COMMAND: /gsd:quick Fix the bug where Clear does not correctly send 300 delete',
        '   signals - only one delete signal is actually being sent (1 character after',
        '  the cursor gets deleted). Backspaces work well but delete signals are broken.',
        '',
        '────────────',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.ok(result);
      assert.strictEqual(result!.type, 'COMMAND');
      assert.ok(result!.command!.includes('/gsd:quick'));
      assert.ok(result!.command!.includes('delete signals are broken.'));
    });

    it('stops collecting at empty line', () => {
      const screenText = [
        '● COMMAND: first part of command',
        '  second part',
        '',
        'not part of command',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.deepStrictEqual(result, {
        type: 'COMMAND',
        command: 'first part of command second part',
      });
    });

    it('stops collecting at ❯ prompt line', () => {
      const screenText = [
        '● COMMAND: some command text',
        '  continuation',
        '❯  ',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.deepStrictEqual(result, {
        type: 'COMMAND',
        command: 'some command text continuation',
      });
    });

    it('stops collecting at separator line', () => {
      const screenText = [
        '● COMMAND: some command text',
        '  continuation',
        '────────────────────────',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.deepStrictEqual(result, {
        type: 'COMMAND',
        command: 'some command text continuation',
      });
    });

    it('collapses multiple spaces from terminal padding', () => {
      const screenText = [
        '● COMMAND: first part    ',
        '   second part',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.deepStrictEqual(result, {
        type: 'COMMAND',
        command: 'first part second part',
      });
    });
  });

  describe('multi-line ESCALATE', () => {
    it('collects continuation lines for wrapped reason', () => {
      const screenText = [
        '● ESCALATE: The task appears to be complete. All tests pass',
        '  and the implementation matches the requirements.',
        '',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.ok(result);
      assert.strictEqual(result!.type, 'ESCALATE');
      assert.ok(result!.reason!.includes('All tests pass'));
      assert.ok(result!.reason!.includes('matches the requirements.'));
    });
  });
});
