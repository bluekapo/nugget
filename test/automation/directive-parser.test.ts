import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirective, parseContextBlock, parseDirectiveWithContext } from '../../src/automation/directive-parser.js';
import { stripAnsi } from '../../src/automation/engine.js';

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

  describe('single-bullet CONTEXT + directive (relaxed parsing)', () => {
    it('single ● with CONTEXT + COMMAND returns both', () => {
      const text = '● CONTEXT: info\nCOMMAND: npm test';
      const result = parseDirectiveWithContext(text);
      assert.deepStrictEqual(result.directive, { type: 'COMMAND', command: 'npm test' });
      assert.strictEqual(result.context, 'info');
    });

    it('single ● with CONTEXT + ESCALATE returns both', () => {
      const text = '● CONTEXT: info\nESCALATE: task done';
      const result = parseDirectiveWithContext(text);
      assert.deepStrictEqual(result.directive, { type: 'ESCALATE', reason: 'task done' });
      assert.strictEqual(result.context, 'info');
    });

    it('single ● with CONTEXT + DONE returns both', () => {
      const text = '● CONTEXT: info\nDONE: all good';
      const result = parseDirectiveWithContext(text);
      assert.deepStrictEqual(result.directive, { type: 'DONE', summary: 'all good' });
      assert.strictEqual(result.context, 'info');
    });

    it('single ● with CONTEXT + CLEAR returns both', () => {
      const text = '● CONTEXT: info\nCLEAR';
      const result = parseDirectiveWithContext(text);
      assert.deepStrictEqual(result.directive, { type: 'CLEAR' });
      assert.strictEqual(result.context, 'info');
    });

    it('single ● with CONTEXT + ENTER returns both', () => {
      const text = '● CONTEXT: info\nENTER';
      const result = parseDirectiveWithContext(text);
      assert.deepStrictEqual(result.directive, { type: 'ENTER' });
      assert.strictEqual(result.context, 'info');
    });

    it('single ● with CONTEXT + RESET returns both', () => {
      const text = '● CONTEXT: info\nRESET';
      const result = parseDirectiveWithContext(text);
      assert.deepStrictEqual(result.directive, { type: 'RESET' });
      assert.strictEqual(result.context, 'info');
    });

    it('two-● response still works (regression check)', () => {
      const text = '● CONTEXT: info\n● COMMAND: npm test';
      const result = parseDirectiveWithContext(text);
      assert.deepStrictEqual(result.directive, { type: 'COMMAND', command: 'npm test' });
      assert.strictEqual(result.context, 'info');
    });

    it('bare COMMAND without any ● still returns null from parseDirective (safety)', () => {
      const result = parseDirective('COMMAND: npm test');
      assert.strictEqual(result, null);
    });

    it('ignores echoed prompt example directives, finds actual response directive', () => {
      // Simulates a real response buffer where:
      // - First part is the echoed prompt with example directives (bare, no ●)
      // - Second part is the actual orchestrator response (● CONTEXT + bare COMMAND)
      const text = [
        'Example correct response (your ENTIRE output should look like this):',
        'COMMAND: Fix the bug in src/session/pty.ts where delete signals are not sent correctly',
        '',
        'Example CONTEXT modifier (attach to any directive):',
        'CONTEXT: Worker is using Next.js App Router',
        'COMMAND: Fix the routing issue',
        '',
        '● CONTEXT: The project uses ESM modules',
        'COMMAND: npm run build && npm test',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive);
      assert.strictEqual(result.directive!.type, 'COMMAND');
      assert.strictEqual((result.directive as any).command, 'npm run build && npm test');
      assert.strictEqual(result.context, 'The project uses ESM modules');
    });
  });

  describe('collectContinuation stops at directive keywords', () => {
    it('CONTEXT text does not swallow COMMAND: line', () => {
      const text = '● CONTEXT: first\nCOMMAND: npm test';
      const context = parseContextBlock(text);
      assert.strictEqual(context, 'first');
    });

    it('CONTEXT text does not swallow ESCALATE: line', () => {
      const text = '● CONTEXT: first\nESCALATE: reason';
      const context = parseContextBlock(text);
      assert.strictEqual(context, 'first');
    });

    it('CONTEXT text does not swallow DONE: line', () => {
      const text = '● CONTEXT: first\nDONE: summary';
      const context = parseContextBlock(text);
      assert.strictEqual(context, 'first');
    });

    it('CONTEXT text does not swallow CLEAR line', () => {
      const text = '● CONTEXT: first\nCLEAR';
      const context = parseContextBlock(text);
      assert.strictEqual(context, 'first');
    });

    it('CONTEXT text does not swallow ENTER line', () => {
      const text = '● CONTEXT: first\nENTER';
      const context = parseContextBlock(text);
      assert.strictEqual(context, 'first');
    });

    it('CONTEXT text does not swallow RESET line', () => {
      const text = '● CONTEXT: first\nRESET';
      const context = parseContextBlock(text);
      assert.strictEqual(context, 'first');
    });
  });

  describe('single-bullet CONTEXT + multi-line COMMAND', () => {
    it('collects wrapped COMMAND after CONTEXT without ●', () => {
      const text = [
        '● CONTEXT: project info here',
        'COMMAND: npm run build && npm test',
        '  --coverage --filter=auth',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.strictEqual(result.context, 'project info here');
      assert.ok(result.directive);
      assert.strictEqual(result.directive!.type, 'COMMAND');
      assert.strictEqual((result.directive as any).command, 'npm run build && npm test --coverage --filter=auth');
    });
  });

  describe('mid-line directive keywords (terminal wrapping)', () => {
    it('finds COMMAND: mid-line after CONTEXT continuation text', () => {
      // Simulates TUI wrapping: CONTEXT text ends, then padding, then COMMAND on same line
      const text = [
        '● CONTEXT: This is a backend project using TypeScript',
        '  communication.                                                                  COMMAND: What is the project structure',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive, 'should find mid-line COMMAND');
      assert.strictEqual(result.directive!.type, 'COMMAND');
      assert.strictEqual((result.directive as any).command, 'What is the project structure');
      assert.ok(result.context, 'should find CONTEXT');
      // CONTEXT should NOT include the COMMAND text
      assert.ok(!(result.context as string).includes('COMMAND'), 'context should not contain COMMAND keyword');
    });

    it('prefers actual mid-line COMMAND over prompt-echo example', () => {
      // Full scenario: echoed prompt with example directives + actual response with mid-line COMMAND
      const text = [
        'Example CONTEXT modifier (attach to any directive):',
        'CONTEXT: Worker is using Next.js App Router',
        'COMMAND: Fix the routing issue',
        '',
        '● CONTEXT: This is a backend-antibot project using TypeScript Fastify 5 with C++',
        '  native modules for bot/DDoS protection. Testing orchestrator-worker',
        '  communication.                                                                  COMMAND: What is the current project structure under src/routes/',
        '  and how many route files exist',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive, 'should find directive');
      assert.strictEqual(result.directive!.type, 'COMMAND');
      // Must find the actual command, NOT the example "Fix the routing issue"
      assert.ok(
        (result.directive as any).command.includes('project structure'),
        `expected actual command but got: ${(result.directive as any).command}`
      );
      assert.ok(result.context);
      assert.ok((result.context as string).includes('backend-antibot'));
    });

    it('collectContinuation stops before mid-line COMMAND keyword', () => {
      const text = [
        '● CONTEXT: project info',
        '  more info                                COMMAND: do something',
      ].join('\n');
      const context = parseContextBlock(text);
      assert.ok(context, 'should find context');
      assert.ok(!context!.includes('COMMAND'), 'context should not swallow COMMAND keyword');
    });

    it('handles ESCALATE: mid-line after CONTEXT text', () => {
      const text = [
        '● CONTEXT: info about the project',
        '  details here.                                                                   ESCALATE: Cannot access the database',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive, 'should find mid-line ESCALATE');
      assert.strictEqual(result.directive!.type, 'ESCALATE');
      assert.strictEqual((result.directive as any).reason, 'Cannot access the database');
    });

    it('handles DONE: mid-line after CONTEXT text', () => {
      const text = [
        '● CONTEXT: project state saved',
        '  final notes.                                                                    DONE: Task completed successfully',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive, 'should find mid-line DONE');
      assert.strictEqual(result.directive!.type, 'DONE');
      assert.strictEqual((result.directive as any).summary, 'Task completed successfully');
    });

    it('handles entire response on one line (no newlines)', () => {
      // Edge case: raw PTY buffer has no newlines between CONTEXT and COMMAND
      const text = '● CONTEXT: project info                                                         COMMAND: npm test';
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive, 'should find COMMAND on same line as ● CONTEXT');
      assert.strictEqual(result.directive!.type, 'COMMAND');
      assert.strictEqual((result.directive as any).command, 'npm test');
    });

    it('finds CLEAR mid-line after CONTEXT continuation text', () => {
      // Bug: CLEAR has no colon, so splitMidLineDirectives didn't split it.
      // CLEAR was swallowed into CONTEXT text, then parseDirectiveRelaxed
      // matched a stale COMMAND from echoed prompt examples instead.
      const text = [
        '● CONTEXT: This is a test run. Task: clear worker session, ask a question, save',
        '  context.                                                                        CLEAR',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive, 'should find mid-line CLEAR');
      assert.strictEqual(result.directive!.type, 'CLEAR');
      assert.ok(result.context, 'should find CONTEXT');
      assert.ok(!(result.context as string).includes('CLEAR'), 'context should not contain CLEAR keyword');
    });

    it('CLEAR mid-line not confused with prompt-echo COMMAND example', () => {
      // Full reproduction: echoed prompt with COMMAND example + actual CONTEXT+CLEAR response.
      // Before fix: parser returned COMMAND "Fix the routing issue" from prompt echo.
      const text = [
        'Example CONTEXT modifier (attach to any directive):',
        'CONTEXT: Worker is using Next.js App Router',
        'COMMAND: Fix the routing issue',
        '',
        '● CONTEXT: This is a test run. Task: clear worker session, ask a question, save',
        '  context.                                                                        CLEAR',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive, 'should find directive');
      assert.strictEqual(result.directive!.type, 'CLEAR', 'should be CLEAR, not COMMAND from prompt echo');
      assert.ok(result.context);
    });

    it('finds ENTER mid-line after CONTEXT continuation text', () => {
      const text = [
        '● CONTEXT: waiting for confirmation',
        '  proceed.                                                                        ENTER',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive, 'should find mid-line ENTER');
      assert.strictEqual(result.directive!.type, 'ENTER');
    });

    it('finds RESET mid-line after CONTEXT continuation text', () => {
      const text = [
        '● CONTEXT: stale state detected',
        '  clearing.                                                                       RESET',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive, 'should find mid-line RESET');
      assert.strictEqual(result.directive!.type, 'RESET');
    });
  });

  describe('completion marker boundary', () => {
    it('COMMAND continuation stops at ✻ completion marker', () => {
      const text = [
        '● CONTEXT: info',
        'COMMAND: /gsd:quick Fix the bug',
        '  with continuation text.',
        '✻ Crunched for 2m 14s',
        '',
        '────────────────────────────────',
        '❯ ',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive);
      assert.strictEqual(result.directive!.type, 'COMMAND');
      const cmd = (result.directive as any).command;
      assert.ok(!cmd.includes('Crunched'), `command should not include completion marker, got: ${cmd}`);
      assert.strictEqual(cmd, '/gsd:quick Fix the bug with continuation text.');
    });

    it('CONTEXT continuation stops at ✻ completion marker', () => {
      const text = [
        '● CONTEXT: project info',
        '  more context.',
        '✻ Brewed for 30s',
      ].join('\n');
      const context = parseContextBlock(text);
      assert.ok(context);
      assert.ok(!context!.includes('Brewed'), 'context should not include completion marker');
      assert.strictEqual(context, 'project info more context.');
    });
  });

  describe('multi-repaint buffer (Ink TUI streaming)', () => {
    it('parseContextBlock finds LAST ● CONTEXT (complete render, not partial)', () => {
      const text = [
        // Render 1 (partial)
        '● CONTEXT: Key files for',
        '',
        // Render 2 (more text)
        '● CONTEXT: Key files for automation hub refactor: (1) HubRenderer at',
        '  src/telegram/renderers/hub.ts',
        '',
        // Render 3 (final, complete)
        '● CONTEXT: Key files for automation hub refactor: (1) HubRenderer at',
        '  src/telegram/renderers/hub.ts - lines 34-42 check for active automation.',
        '  sub-section accessible via button.',
      ].join('\n');
      const context = parseContextBlock(text);
      assert.ok(context);
      assert.ok(context!.includes('sub-section accessible via button'), `expected full context, got: ${context}`);
    });

    it('full multi-repaint scenario: finds both directive and complete context', () => {
      const text = [
        // Echo examples
        'COMMAND: Fix the bug',
        'CONTEXT: Worker uses React',
        '',
        // Partial repaint
        '● CONTEXT: Key files for',
        '',
        // Final repaint (complete)
        '● CONTEXT: Key files for automation hub refactor.',
        '  sub-section accessible via button.',
        '  COMMAND: /gsd:quick Fix the bug with the automation hub',
        '   so that hub always renders normally.',
        '✻ Crunched for 2m 14s',
        '',
        '────────────────────────────────',
        '❯ ',
      ].join('\n');
      const result = parseDirectiveWithContext(text);
      assert.ok(result.directive);
      assert.strictEqual(result.directive!.type, 'COMMAND');
      const cmd = (result.directive as any).command;
      assert.ok(cmd.includes('automation hub'), `expected full command, got: ${cmd}`);
      assert.ok(!cmd.includes('Crunched'), `command should not include completion marker, got: ${cmd}`);
      assert.ok(result.context);
      assert.ok(result.context!.includes('sub-section'), `expected complete context, got: ${result.context}`);
    });

    it('stale buffer: prefers relaxed directive over stale ● COMMAND from previous cycle', () => {
      // In follow-up cycles (no /clear), old ● COMMAND from cycle 1 persists in
      // Ink TUI repaints. The current cycle's CONTEXT + COMMAND are under a single
      // ● bullet, so COMMAND lacks its own ● prefix. The relaxed parser should
      // find the current COMMAND, not the stale one.
      const text = [
        // Stale content from cycle 1 (still in Ink repaint buffer)
        '● COMMAND: I need to understand the current automation system in this',
        '  project. Please explore the codebase and give me a detailed summary.',
        '',
        '✻ Cogitated for 2m 6s',
        '',
        '────────────────────────────────',
        '❯ ',
        '',
        // Current cycle 2 response: CONTEXT + COMMAND under single ● bullet
        '● CONTEXT: This is a Telegram bot project. The hub is a Telegram message.',
        '  COMMAND: Now let us proceed with the task. Use /gsd:quick to implement this',
        '  improvement to the automation workflow.',
        '',
        '✻ Crunched for 1m 30s',
        '',
        '────────────────────────────────',
        '❯ ',
      ].join('\n');
      const result = parseDirectiveWithContext(text);

      // Should find the current cycle's COMMAND, not the stale one
      assert.ok(result.directive, 'should find a directive');
      assert.strictEqual(result.directive!.type, 'COMMAND');
      const cmd = (result.directive as any).command;
      assert.ok(cmd.includes('proceed with the task'), `expected current command, got: ${cmd}`);
      assert.ok(!cmd.includes('understand the current automation'), `should not return stale command, got: ${cmd}`);

      // Should find CONTEXT
      assert.ok(result.context, 'should find context');
      assert.ok(result.context!.includes('Telegram bot'), `expected context content, got: ${result.context}`);
    });
  });
});

describe('stripAnsi', () => {
  it('resolves Ink TUI streaming bare CRs to final rendered text', () => {
    // Ink progressively repaints: "● Y\r● YE\r● YES\n"
    // Only the final repaint before \n should survive
    const result = stripAnsi('● Y\r● YE\r● YES\n');
    assert.strictEqual(result, '● YES\n');
  });

  it('resolves simple bare CR as terminal overwrite', () => {
    // "abc\rdef" means def overwrites abc (cursor returns to start of line)
    const result = stripAnsi('abc\rdef');
    assert.strictEqual(result, 'def');
  });

  it('preserves normal \\r\\n line endings unchanged', () => {
    const result = stripAnsi('line1\r\nline2\r\nline3\r\n');
    assert.strictEqual(result, 'line1\r\nline2\r\nline3\r\n');
  });

  it('passes through text with no bare CRs unchanged', () => {
    const text = 'hello world\nno bare CRs here\n';
    const result = stripAnsi(text);
    assert.strictEqual(result, text);
  });

  it('replaces CSI cursor position with newline to preserve line separation', () => {
    // Ink TUI renders response and spinner at different rows via cursor positioning
    // \x1b[5;1H = cursor to row 5, col 1; \x1b[6;1H = cursor to row 6, col 1
    const raw = '\x1b[5;1H● COMMAND: /gsd:plan-phase 19\x1b[6;1H✶ Scurrying…\x1b[7;1H❯ ';
    const result = stripAnsi(raw);
    // Each cursor position becomes a newline — command stays on its own line
    assert.ok(result.includes('● COMMAND: /gsd:plan-phase 19\n'),
      `Expected command on own line, got: ${JSON.stringify(result)}`);
    assert.ok(!result.includes('19✶'),
      `Command and spinner should not merge, got: ${JSON.stringify(result)}`);
  });

  it('handles cursor positioning + bare CR (Ink repaint with spinner overwrite)', () => {
    // Ink positions spinner, then overwrites with next animation frame via bare CR
    const raw = '\x1b[5;1H● COMMAND: /clear\x1b[6;1H✶ Osmosing…\r✽ Ruminating…';
    const result = stripAnsi(raw);
    assert.ok(result.includes('● COMMAND: /clear\n'),
      `Command should be on own line, got: ${JSON.stringify(result)}`);
    // Bare CR handling: "✶ Osmosing…\r✽ Ruminating…" → "✽ Ruminating…"
    assert.ok(result.includes('✽ Ruminating…'),
      `Last spinner frame should survive bare CR, got: ${JSON.stringify(result)}`);
  });

  it('strips OSC 8 hyperlinks terminated by ST (ESC backslash)', () => {
    // OSC 8 hyperlinks: \x1b]8;params;url\x1b\\clickable text\x1b]8;;\x1b\\
    const raw = 'See \x1b]8;;https://example.com\x1b\\docs\x1b]8;;\x1b\\ for details';
    const result = stripAnsi(raw);
    assert.strictEqual(result, 'See docs for details');
  });

  it('strips OSC 8 hyperlinks without eating content between links', () => {
    // Two separate hyperlinks with normal text between them
    const raw = '\x1b]8;;https://a.com\x1b\\link1\x1b]8;;\x1b\\ and \x1b]8;;https://b.com\x1b\\link2\x1b]8;;\x1b\\';
    const result = stripAnsi(raw);
    assert.strictEqual(result, 'link1 and link2');
  });

  it('does not merge response and status areas after cursor positioning strip', () => {
    // Reproduces the exact corruption pattern from Claude Code v2.1.74
    // Response at row 10, spinner at row 38, prompt at row 39
    const raw = '\x1b[10;1H● COMMAND: /gsd:execute-phase 19\x1b[38;1H✢ Seasoning…\x1b[39;1H❯ \x1b[40;1H  ⏵⏵ bypass permissions on';
    const result = stripAnsi(raw);
    // Command must be on its own line, not merged with spinner/prompt/footer
    const lines = result.split('\n');
    const cmdLine = lines.find(l => l.includes('● COMMAND:'));
    assert.ok(cmdLine, `Should find ● COMMAND line in: ${JSON.stringify(result)}`);
    assert.strictEqual(cmdLine!.trim(), '● COMMAND: /gsd:execute-phase 19');
  });
});

describe('parseDirective spinner isolation', () => {
  it('does not include spinner text in command via continuation', () => {
    // After cursor positioning fix, spinner ends up on its own line
    const text = '● COMMAND: /gsd:plan-phase 19\n✶ Scurrying…\n❯ ';
    const result = parseDirective(text);
    assert.strictEqual(result?.type, 'COMMAND');
    assert.strictEqual(result?.command, '/gsd:plan-phase 19');
  });

  it('does not include any spinner variant in continuation', () => {
    const text = '● COMMAND: /clear\n✽ Ruminating…\n❯ ';
    const result = parseDirective(text);
    assert.strictEqual(result?.type, 'COMMAND');
    assert.strictEqual(result?.command, '/clear');
  });

  it('does not include middle-dot spinner in continuation', () => {
    const text = '● COMMAND: /gsd:progress\n· Osmosing…\n❯ ';
    const result = parseDirective(text);
    assert.strictEqual(result?.type, 'COMMAND');
    assert.strictEqual(result?.command, '/gsd:progress');
  });

  it('still collects legitimate indented continuation lines', () => {
    // Multi-line commands should still work (continuation stops at spinner, not at normal text)
    const text = '● COMMAND: Fix the bug in\n  src/session/pty.ts where signals fail\n❯ ';
    const result = parseDirective(text);
    assert.strictEqual(result?.type, 'COMMAND');
    assert.ok(result?.command.includes('Fix the bug in'),
      `Should start with first line, got: ${result?.command}`);
    assert.ok(result?.command.includes('src/session/pty.ts'),
      `Should include continuation, got: ${result?.command}`);
  });
});
