import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildConsultationPrompt, buildFollowUpPrompt } from '../../src/automation/prompt-builder.js';
import type { ContextPacket, ConsultationPacket, FollowUpPacket } from '../../src/automation/types.js';

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

  it('includes GSD hint when taskDescription contains gsd', () => {
    const packet: ContextPacket = {
      ...basePacket,
      taskDescription: 'Run gsd workflow on the project',
    };
    const prompt = buildPrompt(packet);
    assert.ok(
      prompt.includes('HINT:') && prompt.includes('good practice to ask the worker some questions'),
      `Expected GSD HINT line in prompt when taskDescription contains "gsd":\n${prompt}`
    );
  });

  it('does not include GSD hint when taskDescription lacks gsd', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      !prompt.includes('HINT:'),
      `Should NOT include HINT line when taskDescription lacks "gsd":\n${prompt}`
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

  it('output contains How to Determine guidance section', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      prompt.includes('How to Determine'),
      `Expected "How to Determine" header in consultation prompt:\n${prompt}`
    );
  });

  it('guidance mentions idle prompt indicator', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      prompt.includes('idle prompt') || prompt.includes('ready for input'),
      `Expected idle prompt indicator guidance in consultation prompt:\n${prompt}`
    );
  });

  it('guidance mentions timing/completion line indicator', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      prompt.includes('Cooked') || prompt.includes('Brewed'),
      `Expected timing line indicator guidance in consultation prompt:\n${prompt}`
    );
  });

  it('guidance mentions follow-up suggestions indicator', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      prompt.includes('Follow-up suggestions') || prompt.includes('follow-up suggestions'),
      `Expected follow-up suggestions indicator guidance in consultation prompt:\n${prompt}`
    );
  });

  it('guidance says NO only when actively processing', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      prompt.includes('actively processing') || prompt.includes('spinner'),
      `Expected guidance about answering NO only when actively processing:\n${prompt}`
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

describe('buildFollowUpPrompt', () => {
  const baseFollowUp: FollowUpPacket = {
    workerScreen: '$ npm test\n\nAll 42 tests passed.',
    lastAction: { action: 'COMMAND: npm test', outcome: 'Tests passed', timestamp: 1700000000000 },
    cycleNumber: 5,
  };

  it('contains worker terminal output in code block', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      prompt.includes('## Worker Terminal Output'),
      `Expected "## Worker Terminal Output" header in follow-up prompt:\n${prompt}`
    );
    assert.ok(
      prompt.includes('$ npm test\n\nAll 42 tests passed.'),
      `Expected worker screen text in follow-up prompt:\n${prompt}`
    );
    // Should be inside a code block
    const screenIdx = prompt.indexOf('$ npm test');
    const beforeScreen = prompt.lastIndexOf('```', screenIdx);
    const afterScreen = prompt.indexOf('```', screenIdx);
    assert.ok(beforeScreen !== -1, 'Expected ``` before screen text');
    assert.ok(afterScreen !== -1, 'Expected ``` after screen text');
  });

  it('contains last action with action and outcome', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      prompt.includes('## Last Action'),
      `Expected "## Last Action" header in follow-up prompt:\n${prompt}`
    );
    assert.ok(
      prompt.includes('COMMAND: npm test'),
      `Expected last action text in follow-up prompt:\n${prompt}`
    );
    assert.ok(
      prompt.includes('Tests passed'),
      `Expected last action outcome in follow-up prompt:\n${prompt}`
    );
  });

  it('with lastAction=null shows first cycle indicator', () => {
    const packet: FollowUpPacket = {
      workerScreen: 'screen',
      lastAction: null,
      cycleNumber: 2,
    };
    const prompt = buildFollowUpPrompt(packet);
    assert.ok(
      prompt.toLowerCase().includes('first cycle') || prompt.toLowerCase().includes('(first cycle'),
      `Expected first cycle indicator when lastAction is null:\n${prompt}`
    );
  });

  it('contains cycle number', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      prompt.includes('5'),
      `Expected cycle number 5 in follow-up prompt:\n${prompt}`
    );
    assert.ok(
      prompt.includes('cycle 5') || prompt.includes('Cycle 5'),
      `Expected cycle number in context like "cycle 5" or "Cycle 5":\n${prompt}`
    );
  });

  it('does NOT contain role section', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      !prompt.includes('## Your Role'),
      `Follow-up prompt should NOT contain "## Your Role":\n${prompt}`
    );
  });

  it('does NOT contain task description section', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      !prompt.includes('## Task'),
      `Follow-up prompt should NOT contain "## Task":\n${prompt}`
    );
  });

  it('does NOT contain directive reference', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      !prompt.includes('Available directives:'),
      `Follow-up prompt should NOT contain "Available directives:":\n${prompt}`
    );
  });

  it('does NOT contain persistent context section', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      !prompt.includes('Persistent Context'),
      `Follow-up prompt should NOT contain "Persistent Context":\n${prompt}`
    );
  });

  it('includes reminder line about single directive', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      prompt.includes('Respond with a single directive line.'),
      `Expected reminder line "Respond with a single directive line." in follow-up prompt:\n${prompt}`
    );
  });

  it('mama prompt (buildPrompt) still contains all PRM-02 sections', () => {
    const mamaPacket: ContextPacket = {
      taskDescription: 'Run the tests',
      workerScreen: 'screen output',
      actionLog: { summary: null, recent: [], totalCount: 0 },
      cycleNumber: 1,
    };
    const prompt = buildPrompt(mamaPacket);
    assert.ok(prompt.includes('## Your Role'), 'Mama prompt should contain "## Your Role"');
    assert.ok(prompt.includes('## Task'), 'Mama prompt should contain "## Task"');
    assert.ok(prompt.includes('Worker Terminal Output') || prompt.includes('Current Worker Terminal Output'),
      'Mama prompt should contain worker terminal output section');
    assert.ok(prompt.includes('Action Log'), 'Mama prompt should contain "Action Log"');
    assert.ok(prompt.includes('Available directives:'), 'Mama prompt should contain "Available directives:"');
  });
});
