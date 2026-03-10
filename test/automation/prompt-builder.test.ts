import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildConsultationPrompt } from '../../src/automation/prompt-builder.js';
import type { ContextPacket, ConsultationPacket } from '../../src/automation/types.js';

describe('buildPrompt', () => {
  const basePacket: ContextPacket = {
    taskDescription: 'Run the test suite and fix any failures',
    workerScreen: '$ npm test\n\nAll 42 tests passed.',
    actionLog: {
      summary: null,
      recent: [
        { action: 'COMMAND: npm test', outcome: 'Tests executed successfully', timestamp: 1700000000000 },
        { action: 'COMMAND: npm run lint', outcome: 'No lint errors found', timestamp: 1700000010000 },
      ],
      totalCount: 2,
    },
    cycleNumber: 3,
  };

  it('output contains task description text verbatim', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      prompt.includes('Run the test suite and fix any failures'),
      `Expected task description in prompt:\n${prompt}`
    );
  });

  it('output contains worker screen text inside a code block', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      prompt.includes('$ npm test\n\nAll 42 tests passed.'),
      `Expected worker screen text in prompt:\n${prompt}`
    );
    // Should be inside a code block (``` before and after)
    const screenIdx = prompt.indexOf('$ npm test');
    const beforeScreen = prompt.lastIndexOf('```', screenIdx);
    const afterScreen = prompt.indexOf('```', screenIdx);
    assert.ok(beforeScreen !== -1, 'Expected ``` before screen text');
    assert.ok(afterScreen !== -1, 'Expected ``` after screen text');
  });

  it('output contains action log entries with "Sent:" and "Result:" labels wrapped in backticks', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(prompt.includes('Sent: `COMMAND: npm test`'), `Expected backtick-wrapped "Sent:" label in prompt`);
    assert.ok(prompt.includes('Result: `Tests executed successfully`'), `Expected backtick-wrapped "Result:" label in prompt`);
    assert.ok(prompt.includes('Sent: `COMMAND: npm run lint`'), `Expected second backtick-wrapped "Sent:" label in prompt`);
    assert.ok(prompt.includes('Result: `No lint errors found`'), `Expected second backtick-wrapped "Result:" label in prompt`);
  });

  it('with empty action log shows "(no actions taken yet" message', () => {
    const emptyPacket: ContextPacket = {
      taskDescription: 'Do something',
      workerScreen: '$ _',
      actionLog: { summary: null, recent: [], totalCount: 0 },
      cycleNumber: 1,
    };
    const prompt = buildPrompt(emptyPacket);
    assert.ok(
      prompt.toLowerCase().includes('no actions taken yet'),
      `Expected "no actions taken yet" message in prompt:\n${prompt}`
    );
  });

  it('output contains cycle number', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      prompt.includes('3'),
      `Expected cycle number 3 in prompt:\n${prompt}`
    );
    // Check it appears in a meaningful context (not just any "3")
    assert.ok(
      prompt.includes('cycle 3') || prompt.includes('Cycle 3') || prompt.includes('cycle: 3'),
      `Expected cycle number in context like "cycle 3" in prompt:\n${prompt}`
    );
  });

  it('output contains all directive types (COMMAND, SELECT, ENTER, ESCALATE, DONE, CLEAR, RESET, CONTEXT)', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(prompt.includes('COMMAND'), 'Expected COMMAND directive type');
    assert.ok(prompt.includes('SELECT'), 'Expected SELECT directive type');
    assert.ok(prompt.includes('ENTER'), 'Expected ENTER directive type');
    assert.ok(prompt.includes('ESCALATE'), 'Expected ESCALATE directive type');
    assert.ok(prompt.includes('DONE'), 'Expected DONE directive type');
    assert.ok(prompt.includes('CLEAR'), 'Expected CLEAR directive type');
    assert.ok(prompt.includes('RESET'), 'Expected RESET directive type');
    assert.ok(prompt.includes('CONTEXT:'), 'Expected CONTEXT modifier');
  });

  it('output contains DONE directive in available directives list', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      prompt.includes('DONE: <summary>'),
      `Expected DONE directive format in prompt:\n${prompt}`
    );
  });

  it('ESCALATE description says blockers only, not task completion', () => {
    const prompt = buildPrompt(basePacket);
    // ESCALATE line should say "genuine blockers" and NOT "task completion"
    const escalateLine = prompt.split('\n').find(l => l.includes('ESCALATE:') && l.includes('--'));
    assert.ok(escalateLine, 'Expected ESCALATE directive line in prompt');
    assert.ok(
      escalateLine!.includes('genuine blockers'),
      `Expected "genuine blockers" in ESCALATE description: ${escalateLine}`
    );
    assert.ok(
      !escalateLine!.includes('task completion'),
      `ESCALATE description should NOT mention "task completion": ${escalateLine}`
    );
  });

  it('output contains ESCALATE wrong example for task completion', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      prompt.includes('ESCALATE: Task is complete'),
      `Expected wrong example for ESCALATE task completion:\n${prompt}`
    );
  });

  it('includes persistent context section when persistentContext provided', () => {
    const packet: ContextPacket = {
      ...basePacket,
      persistentContext: ['Worker uses React', 'DB is PostgreSQL'],
    };
    const prompt = buildPrompt(packet);
    assert.ok(
      prompt.includes('Persistent Context'),
      `Expected "Persistent Context" header in prompt:\n${prompt}`
    );
    assert.ok(
      prompt.includes('Worker uses React'),
      `Expected first context item in prompt:\n${prompt}`
    );
    assert.ok(
      prompt.includes('DB is PostgreSQL'),
      `Expected second context item in prompt:\n${prompt}`
    );
  });

  it('omits persistent context section when persistentContext is empty', () => {
    const packet: ContextPacket = {
      ...basePacket,
      persistentContext: [],
    };
    const prompt = buildPrompt(packet);
    assert.ok(
      !prompt.includes('Persistent Context'),
      `Should NOT include "Persistent Context" when array is empty:\n${prompt}`
    );
  });

  it('omits persistent context section when persistentContext undefined', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      !prompt.includes('Persistent Context'),
      `Should NOT include "Persistent Context" when undefined:\n${prompt}`
    );
  });

  it('directive reference includes CLEAR and RESET', () => {
    const prompt = buildPrompt(basePacket);
    const lines = prompt.split('\n');
    const clearLine = lines.find(l => l.includes('CLEAR') && l.includes('--'));
    const resetLine = lines.find(l => l.includes('RESET') && l.includes('--'));
    assert.ok(clearLine, `Expected CLEAR directive in reference:\n${prompt}`);
    assert.ok(resetLine, `Expected RESET directive in reference:\n${prompt}`);
  });

  it('directive reference documents CONTEXT modifier', () => {
    const prompt = buildPrompt(basePacket);
    const lines = prompt.split('\n');
    const contextLine = lines.find(l => l.includes('CONTEXT:') && l.includes('--'));
    assert.ok(contextLine, `Expected CONTEXT: modifier documentation in prompt:\n${prompt}`);
  });
});

describe('buildConsultationPrompt', () => {
  const basePacket: ConsultationPacket = {
    taskDescription: 'Run the test suite and fix any failures',
    workerScreen: '$ npm test\n\nAll 42 tests passed.',
    actionLog: {
      summary: null,
      recent: [
        { action: 'COMMAND: npm test', outcome: 'Tests executed successfully', timestamp: 1700000000000 },
        { action: 'COMMAND: npm run lint', outcome: 'No lint errors found', timestamp: 1700000010000 },
      ],
      totalCount: 2,
    },
    cycleNumber: 3,
  };

  it('output contains worker screen text', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      prompt.includes('$ npm test\n\nAll 42 tests passed.'),
      `Expected worker screen text in consultation prompt:\n${prompt}`
    );
  });

  it('output contains task description', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      prompt.includes('Run the test suite and fix any failures'),
      `Expected task description in consultation prompt:\n${prompt}`
    );
  });

  it('output asks YES/NO question about worker completion', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      prompt.includes('YES') && prompt.includes('NO'),
      `Expected YES/NO question in consultation prompt:\n${prompt}`
    );
    assert.ok(
      prompt.toLowerCase().includes('finished') || prompt.toLowerCase().includes('complete'),
      `Expected question about worker being finished/complete:\n${prompt}`
    );
  });

  it('output contains action log entries wrapped in backticks', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(prompt.includes('Sent: `COMMAND: npm test`'), 'Expected backtick-wrapped action log entry');
    assert.ok(prompt.includes('Result: `Tests executed successfully`'), 'Expected backtick-wrapped action log outcome');
  });

  it('output instructs to respond with YES or NO only', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      prompt.includes('YES') && prompt.includes('NO') && prompt.toLowerCase().includes('nothing else'),
      `Expected instruction to respond with YES or NO only:\n${prompt}`
    );
  });

  it('output includes idle duration when idleDurationMs is provided', () => {
    const packetWithDuration: ConsultationPacket = {
      ...basePacket,
      idleDurationMs: 15000,
    };
    const prompt = buildConsultationPrompt(packetWithDuration);
    assert.ok(
      prompt.includes('idle for 15 seconds'),
      `Expected idle duration text in consultation prompt:\n${prompt}`
    );
  });

  it('output does NOT include idle duration when idleDurationMs is not provided', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      !prompt.includes('idle for'),
      `Should NOT contain idle duration text when not provided:\n${prompt}`
    );
  });

  it('output does NOT contain directive instructions (COMMAND, SELECT, etc.)', () => {
    const prompt = buildConsultationPrompt(basePacket);
    // Should NOT have the directive instruction block
    assert.ok(
      !prompt.includes('COMMAND: <'),
      `Consultation prompt should NOT contain COMMAND directive format:\n${prompt}`
    );
    assert.ok(
      !prompt.includes('SELECT: <'),
      `Consultation prompt should NOT contain SELECT directive format:\n${prompt}`
    );
    assert.ok(
      !prompt.includes('WAIT: <'),
      `Consultation prompt should NOT contain WAIT directive format:\n${prompt}`
    );
    assert.ok(
      !prompt.includes('ESCALATE: <'),
      `Consultation prompt should NOT contain ESCALATE directive format:\n${prompt}`
    );
    assert.ok(
      !prompt.includes('DONE: <'),
      `Consultation prompt should NOT contain DONE directive format:\n${prompt}`
    );
  });
});

describe('compressed action log rendering', () => {
  it('buildPrompt with summary=null renders entries same as before (no summary paragraph)', () => {
    const packet: ContextPacket = {
      taskDescription: 'Test task',
      workerScreen: 'screen',
      actionLog: {
        summary: null,
        recent: [
          { action: 'COMMAND: npm test', outcome: 'passed', timestamp: 1700000000000 },
        ],
        totalCount: 1,
      },
      cycleNumber: 2,
    };
    const prompt = buildPrompt(packet);
    // Should NOT contain a blockquote summary
    assert.ok(!prompt.includes('> Summary'), 'Should not contain summary blockquote when summary is null');
    // Should contain the entry
    assert.ok(prompt.includes('Sent: `COMMAND: npm test`'), 'Should contain action entry');
  });

  it('buildPrompt with summary string renders summary paragraph BEFORE recent entries', () => {
    const packet: ContextPacket = {
      taskDescription: 'Test task',
      workerScreen: 'screen',
      actionLog: {
        summary: 'Summary of actions 1-40 (40 actions): 35 COMMANDs, 3 CLEARs, 2 RESETs. Outcomes: 30 successful, 5 failed, 5 pending.',
        recent: [
          { action: 'COMMAND: npm test', outcome: 'passed', timestamp: 1700000000000 },
          { action: 'COMMAND: npm build', outcome: 'built', timestamp: 1700000010000 },
        ],
        totalCount: 42,
      },
      cycleNumber: 43,
    };
    const prompt = buildPrompt(packet);
    // Summary should appear as blockquote
    assert.ok(prompt.includes('> Summary of actions 1-40'),
      `Expected summary as blockquote in prompt:\n${prompt}`);
    // Summary should come before recent entries
    const summaryIdx = prompt.indexOf('> Summary of actions');
    const entryIdx = prompt.indexOf('Sent: `COMMAND: npm test`');
    assert.ok(summaryIdx < entryIdx, 'Summary should appear before recent entries');
  });

  it('buildPrompt action log header shows total count when summary exists', () => {
    const packet: ContextPacket = {
      taskDescription: 'Test task',
      workerScreen: 'screen',
      actionLog: {
        summary: 'Summary of actions 1-40 (40 actions): 40 COMMANDs. Outcomes: 40 successful, 0 failed, 0 pending.',
        recent: [
          { action: 'COMMAND: final', outcome: 'done', timestamp: 1700000000000 },
        ],
        totalCount: 41,
      },
      cycleNumber: 42,
    };
    const prompt = buildPrompt(packet);
    // Header should include total count format
    assert.ok(
      prompt.includes('41 total') && prompt.includes('showing last 1') && prompt.includes('cycle 42'),
      `Expected total count header format in prompt:\n${prompt}`
    );
  });

  it('buildPrompt recent entries are numbered from offset when summary exists', () => {
    const packet: ContextPacket = {
      taskDescription: 'Test task',
      workerScreen: 'screen',
      actionLog: {
        summary: 'Summary of old entries',
        recent: [
          { action: 'COMMAND: action-41', outcome: 'done', timestamp: 1700000000000 },
          { action: 'COMMAND: action-42', outcome: 'done', timestamp: 1700000010000 },
        ],
        totalCount: 42,
      },
      cycleNumber: 43,
    };
    const prompt = buildPrompt(packet);
    // Entry numbering should start from totalCount - recent.length + 1 = 41
    assert.ok(prompt.includes('41. Sent: `COMMAND: action-41`'),
      `Expected entry numbered 41 in prompt:\n${prompt}`);
    assert.ok(prompt.includes('42. Sent: `COMMAND: action-42`'),
      `Expected entry numbered 42 in prompt:\n${prompt}`);
  });

  it('buildConsultationPrompt renders compressed format identically', () => {
    const packet: ConsultationPacket = {
      taskDescription: 'Test task',
      workerScreen: 'screen',
      actionLog: {
        summary: 'Summary of actions 1-30 (30 actions): 30 COMMANDs. Outcomes: 25 successful, 5 failed, 0 pending.',
        recent: [
          { action: 'COMMAND: check', outcome: 'ok', timestamp: 1700000000000 },
        ],
        totalCount: 31,
      },
      cycleNumber: 32,
    };
    const prompt = buildConsultationPrompt(packet);
    // Should have summary blockquote
    assert.ok(prompt.includes('> Summary of actions 1-30'),
      `Expected summary blockquote in consultation prompt:\n${prompt}`);
    // Should have total count header
    assert.ok(prompt.includes('31 total'),
      `Expected total count in consultation prompt header:\n${prompt}`);
  });
});
