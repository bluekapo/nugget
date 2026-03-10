import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirective, parseContextBlock, parseDirectiveWithContext } from '../../src/automation/directive-parser.js';

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

  describe('WAIT directive (removed -- returns null)', () => {
    it('returns null for bare WAIT (graceful no-op)', () => {
      const result = parseDirective('processing\n● WAIT\nstill going');
      assert.strictEqual(result, null);
    });

    it('returns null for WAIT: N (graceful no-op)', () => {
      const result = parseDirective('processing\n● WAIT: 30\nstill going');
      assert.strictEqual(result, null);
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

    it('returns null for ● WAIT: 10 (removed directive)', () => {
      const result = parseDirective('● WAIT: 10');
      assert.strictEqual(result, null);
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

  describe('CLEAR directive', () => {
    it('returns CLEAR type from ● CLEAR', () => {
      const result = parseDirective('● CLEAR');
      assert.deepStrictEqual(result, { type: 'CLEAR' });
    });

    it('handles leading whitespace before ● CLEAR', () => {
      const result = parseDirective('  ● CLEAR');
      assert.deepStrictEqual(result, { type: 'CLEAR' });
    });

    it('returns null for bare CLEAR without ● prefix', () => {
      const result = parseDirective('CLEAR');
      assert.strictEqual(result, null);
    });

    it('returns null for CLEAR with parameters (exact match like ENTER)', () => {
      const result = parseDirective('● CLEAR: extra');
      assert.strictEqual(result, null);
    });
  });

  describe('RESET directive', () => {
    it('returns RESET type from ● RESET', () => {
      const result = parseDirective('● RESET');
      assert.deepStrictEqual(result, { type: 'RESET' });
    });

    it('handles leading whitespace before ● RESET', () => {
      const result = parseDirective('  ● RESET');
      assert.deepStrictEqual(result, { type: 'RESET' });
    });

    it('returns null for bare RESET without ● prefix', () => {
      const result = parseDirective('RESET');
      assert.strictEqual(result, null);
    });

    it('returns null for RESET with parameters (exact match like ENTER)', () => {
      const result = parseDirective('● RESET: extra');
      assert.strictEqual(result, null);
    });
  });

  describe('DONE directive', () => {
    it('extracts summary string from ● DONE: <text>', () => {
      const result = parseDirective('some output\n● DONE: All tests pass and feature works\n\n❯ ');
      assert.deepStrictEqual(result, { type: 'DONE', summary: 'All tests pass and feature works' });
    });

    it('collects multi-line continuation', () => {
      const screenText = [
        '● DONE: All tests pass and the implementation',
        '  matches the requirements perfectly.',
        '',
      ].join('\n');
      const result = parseDirective(screenText);
      assert.ok(result);
      assert.strictEqual(result!.type, 'DONE');
      assert.ok((result as any).summary.includes('All tests pass'));
      assert.ok((result as any).summary.includes('matches the requirements perfectly.'));
    });

    it('returns null without ● prefix', () => {
      const result = parseDirective('DONE: All tests pass');
      assert.strictEqual(result, null);
    });
  });

  describe('YES directive', () => {
    it('returns YES type from ● YES', () => {
      const result = parseDirective('● YES');
      assert.deepStrictEqual(result, { type: 'YES' });
    });

    it('parses YES in multi-line context', () => {
      const result = parseDirective('some output\n● YES\n\n');
      assert.deepStrictEqual(result, { type: 'YES' });
    });

    it('handles leading whitespace before ● YES', () => {
      const result = parseDirective('  ● YES');
      assert.deepStrictEqual(result, { type: 'YES' });
    });

    it('returns null for bare YES without ● prefix', () => {
      const result = parseDirective('YES');
      assert.strictEqual(result, null);
    });
  });

  describe('NO directive', () => {
    it('returns NO type from ● NO', () => {
      const result = parseDirective('● NO');
      assert.deepStrictEqual(result, { type: 'NO' });
    });

    it('parses NO in multi-line context', () => {
      const result = parseDirective('some output\n● NO\n\n');
      assert.deepStrictEqual(result, { type: 'NO' });
    });

    it('handles leading whitespace before ● NO', () => {
      const result = parseDirective('  ● NO');
      assert.deepStrictEqual(result, { type: 'NO' });
    });

    it('returns null for bare NO without ● prefix', () => {
      const result = parseDirective('NO');
      assert.strictEqual(result, null);
    });
  });
});

describe('parseContextBlock', () => {
  it('extracts single-line context from ● CONTEXT: line', () => {
    const result = parseContextBlock('● CONTEXT: project uses React');
    assert.strictEqual(result, 'project uses React');
  });

  it('extracts multi-line context with continuation lines', () => {
    const text = [
      '● CONTEXT: first line',
      '  second line',
      '  third line',
    ].join('\n');
    const result = parseContextBlock(text);
    assert.strictEqual(result, 'first line second line third line');
  });

  it('returns null when no CONTEXT: block present', () => {
    const result = parseContextBlock('● COMMAND: npm test');
    assert.strictEqual(result, null);
  });

  it('returns null for bare CONTEXT: without ● prefix', () => {
    const result = parseContextBlock('CONTEXT: project uses React');
    assert.strictEqual(result, null);
  });

  it('context block coexists with directive in same text', () => {
    const text = [
      '● CONTEXT: Worker is using Next.js',
      '● COMMAND: Fix the routing issue',
    ].join('\n');
    const context = parseContextBlock(text);
    assert.strictEqual(context, 'Worker is using Next.js');
    const directive = parseDirective(text);
    assert.deepStrictEqual(directive, { type: 'COMMAND', command: 'Fix the routing issue' });
  });
});

describe('parseDirectiveWithContext', () => {
  it('text with both directive and context returns both', () => {
    const text = [
      '● CONTEXT: Worker is using Next.js',
      '● COMMAND: Fix the routing issue',
    ].join('\n');
    const result = parseDirectiveWithContext(text);
    assert.deepStrictEqual(result.directive, { type: 'COMMAND', command: 'Fix the routing issue' });
    assert.strictEqual(result.context, 'Worker is using Next.js');
  });

  it('text with directive only returns directive and null context', () => {
    const text = '● COMMAND: npm test';
    const result = parseDirectiveWithContext(text);
    assert.deepStrictEqual(result.directive, { type: 'COMMAND', command: 'npm test' });
    assert.strictEqual(result.context, null);
  });

  it('text with context only returns null directive and context string', () => {
    const text = '● CONTEXT: project uses React';
    const result = parseDirectiveWithContext(text);
    assert.strictEqual(result.directive, null);
    assert.strictEqual(result.context, 'project uses React');
  });
});
