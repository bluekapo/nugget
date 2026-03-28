import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildConsultationPrompt, buildFollowUpPrompt } from '../../src/automation/prompt-builder.js';
import { RETRY_PROMPT } from '../../src/automation/engine.js';
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

  it('output contains action log entries with "Sent:" and "Result:" labels wrapped in triple backtick code blocks', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(prompt.includes('1. Sent:\n```\nCOMMAND: npm test\n```'), 'Expected triple-backtick wrapped action');
    assert.ok(prompt.includes('Result:\n```\nTests executed successfully\n```'), 'Expected triple-backtick wrapped result');
    assert.ok(prompt.includes('2. Sent:\n```\nCOMMAND: npm run lint\n```'), 'Expected second triple-backtick wrapped action');
    assert.ok(prompt.includes('Result:\n```\nNo lint errors found\n```'), 'Expected second triple-backtick wrapped result');
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

  it('always includes CLEAR hint regardless of task content', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      prompt.includes('HINT:') && prompt.includes('CLEAR'),
      `Expected CLEAR HINT line in prompt:\n${prompt}`
    );
  });

  it('includes all 3 hints when taskDescription contains gsd', () => {
    const packet: ContextPacket = {
      ...basePacket,
      taskDescription: 'Run gsd workflow on the project',
    };
    const prompt = buildPrompt(packet);
    const hints = prompt.split('\n').filter(l => l.startsWith('HINT:'));
    assert.equal(hints.length, 3, `Expected 3 HINT lines when task contains "gsd", got ${hints.length}`);
    assert.ok(
      hints.some(h => h.includes('CLEAR')),
      `Expected CLEAR hint in prompt:\n${prompt}`
    );
    assert.ok(
      hints.some(h => h.includes('context first') || h.includes('clarifying questions')),
      `Expected context-gathering hint in prompt:\n${prompt}`
    );
    assert.ok(
      hints.some(h => h.includes('GSD pipeline')),
      `Expected GSD pipeline sequence hint in prompt:\n${prompt}`
    );
  });

  it('includes context-gathering hint for complex/task/workflow/pipeline keywords', () => {
    for (const keyword of ['complex', 'task', 'workflow', 'pipeline']) {
      const packet: ContextPacket = {
        ...basePacket,
        taskDescription: `Handle this ${keyword} for me`,
      };
      const prompt = buildPrompt(packet);
      const hints = prompt.split('\n').filter(l => l.startsWith('HINT:'));
      assert.equal(hints.length, 2, `Expected 2 HINT lines for keyword "${keyword}", got ${hints.length}`);
      assert.ok(
        hints.some(h => h.includes('context first') || h.includes('clarifying questions')),
        `Expected context-gathering hint for keyword "${keyword}":\n${prompt}`
      );
    }
  });

  it('GSD pipeline hint includes correct command sequence', () => {
    const packet: ContextPacket = {
      ...basePacket,
      taskDescription: 'Run gsd for phase 5',
    };
    const prompt = buildPrompt(packet);
    assert.ok(prompt.includes('/gsd:plan-phase'), `Expected plan-phase in GSD pipeline hint:\n${prompt}`);
    assert.ok(prompt.includes('/gsd:execute-phase'), `Expected execute-phase in GSD pipeline hint:\n${prompt}`);
    assert.ok(prompt.includes('/gsd:validate-phase'), `Expected validate-phase in GSD pipeline hint:\n${prompt}`);
    assert.ok(!prompt.includes('/gsd:verify-phase'), `Should NOT mention verify-phase:\n${prompt}`);
  });

  it('includes only CLEAR hint when taskDescription has no trigger keywords', () => {
    const prompt = buildPrompt(basePacket);
    const hints = prompt.split('\n').filter(l => l.startsWith('HINT:'));
    assert.equal(hints.length, 1, `Expected exactly 1 HINT line when task lacks trigger keywords, got ${hints.length}`);
    assert.ok(
      hints[0].includes('CLEAR'),
      `Expected the single hint to be about CLEAR:\n${prompt}`
    );
  });

  it('includes SELECT menu HINT when selectMenuDetected is true', () => {
    const selectPacket: ContextPacket = {
      ...basePacket,
      workerScreen: '\u276F Use existing CONTEXT.md\n  Start fresh discussion\n  Review first',
      selectMenuDetected: true,
    };
    const prompt = buildPrompt(selectPacket);
    const hints = prompt.split('\n').filter(l => l.startsWith('HINT:'));
    const selectHint = hints.find(h => h.includes('SELECT menu'));
    assert.ok(selectHint,
      `Expected a HINT line containing "SELECT menu" when selectMenuDetected is true:\n${prompt}`);
    assert.ok(selectHint!.includes('SELECT:'),
      `SELECT HINT should reference the SELECT: directive format:\n${selectHint}`);
  });

  it('omits SELECT menu HINT when selectMenuDetected is false or undefined', () => {
    // Test with undefined (default basePacket has no selectMenuDetected)
    const prompt1 = buildPrompt(basePacket);
    const hints1 = prompt1.split('\n').filter(l => l.startsWith('HINT:'));
    assert.ok(!hints1.some(h => h.includes('SELECT menu')),
      `Should NOT include SELECT menu HINT when selectMenuDetected is undefined:\n${prompt1}`);

    // Test with explicit false
    const falsePacket: ContextPacket = { ...basePacket, selectMenuDetected: false };
    const prompt2 = buildPrompt(falsePacket);
    const hints2 = prompt2.split('\n').filter(l => l.startsWith('HINT:'));
    assert.ok(!hints2.some(h => h.includes('SELECT menu')),
      `Should NOT include SELECT menu HINT when selectMenuDetected is false:\n${prompt2}`);
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

  it('contains rule prohibiting DONE while worker is actively processing', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      prompt.includes('NEVER use DONE while the worker is actively processing'),
      `Expected DONE prohibition rule in prompt:\n${prompt}`
    );
  });

  it('DONE directive description mentions TERMINATES', () => {
    const prompt = buildPrompt(basePacket);
    const doneLine = prompt.split('\n').find(l => l.includes('DONE: <summary>') && l.includes('--'));
    assert.ok(doneLine, 'Expected DONE directive line in available directives');
    assert.ok(
      doneLine!.includes('TERMINATES'),
      `Expected "TERMINATES" in DONE directive description: ${doneLine}`
    );
  });

  it('wrong examples include premature DONE pattern', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      prompt.includes('DONE: Waiting for'),
      `Expected premature DONE wrong example in prompt:\n${prompt}`
    );
  });

  it('GSD pipeline hint includes phase number N in command examples', () => {
    const packet: ContextPacket = {
      ...basePacket,
      taskDescription: 'Execute GSD milestone pipeline',
    };
    const prompt = buildPrompt(packet);
    assert.ok(
      prompt.includes('/gsd:plan-phase N'),
      `Expected '/gsd:plan-phase N' with phase number placeholder in prompt:\n${prompt}`,
    );
    assert.ok(
      prompt.includes('/gsd:execute-phase N'),
      `Expected '/gsd:execute-phase N' with phase number placeholder in prompt:\n${prompt}`,
    );
    assert.ok(
      prompt.includes('/gsd:validate-phase N'),
      `Expected '/gsd:validate-phase N' with phase number placeholder in prompt:\n${prompt}`,
    );
  });

  it('contains ALL CAPS reinforcement for single directive line output', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(
      prompt.includes('YOUR ENTIRE RESPONSE MUST BE EXACTLY ONE DIRECTIVE LINE'),
      'Expected ALL CAPS reinforcement in mama prompt'
    );
  });
});

describe('RETRY_PROMPT', () => {
  it('contains ALL CAPS reinforcement for single directive line output', () => {
    assert.ok(
      RETRY_PROMPT.includes('YOUR ENTIRE RESPONSE MUST BE EXACTLY ONE DIRECTIVE LINE'),
      'Expected ALL CAPS reinforcement in retry prompt'
    );
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

  it('output contains action log entries wrapped in triple backtick code blocks', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(prompt.includes('1. Sent:\n```\nCOMMAND: npm test\n```'), 'Expected triple-backtick wrapped action log entry');
    assert.ok(prompt.includes('Result:\n```\nTests executed successfully\n```'), 'Expected triple-backtick wrapped action log outcome');
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

  it('does NOT contain directive-line ALL CAPS reinforcement', () => {
    const prompt = buildConsultationPrompt(basePacket);
    assert.ok(
      !prompt.includes('YOUR ENTIRE RESPONSE MUST BE EXACTLY ONE DIRECTIVE LINE'),
      'Consultation prompt should NOT contain directive-line reinforcement'
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
    assert.ok(prompt.includes('1. Sent:\n```\nCOMMAND: npm test\n```'), 'Should contain triple-backtick wrapped action entry');
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
    const entryIdx = prompt.indexOf('41. Sent:\n```\nCOMMAND: npm test\n```');
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
    assert.ok(prompt.includes('41. Sent:\n```\nCOMMAND: action-41\n```'),
      `Expected entry numbered 41 with triple backtick in prompt:\n${prompt}`);
    assert.ok(prompt.includes('42. Sent:\n```\nCOMMAND: action-42\n```'),
      `Expected entry numbered 42 with triple backtick in prompt:\n${prompt}`);
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

  it('contains last action with action and outcome in triple backtick code blocks', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      prompt.includes('## Last Action'),
      `Expected "## Last Action" header in follow-up prompt:\n${prompt}`
    );
    assert.ok(
      prompt.includes('Sent:\n```\nCOMMAND: npm test\n```'),
      `Expected triple-backtick wrapped last action text in follow-up prompt:\n${prompt}`
    );
    assert.ok(
      prompt.includes('Result:\n```\nTests passed\n```'),
      `Expected triple-backtick wrapped last action outcome in follow-up prompt:\n${prompt}`
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

  it('contains critical reminder about DONE during active processing', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      prompt.includes('DONE terminates the automation permanently'),
      `Expected DONE termination reminder in follow-up prompt:\n${prompt}`
    );
  });

  it('includes reminder line about single directive', () => {
    const prompt = buildFollowUpPrompt(baseFollowUp);
    assert.ok(
      prompt.includes('Respond with a single directive line.'),
      `Expected reminder line "Respond with a single directive line." in follow-up prompt:\n${prompt}`
    );
  });

  it('includes SELECT HINT when selectMenuDetected is true', () => {
    const packet: FollowUpPacket = {
      ...baseFollowUp,
      selectMenuDetected: true,
    };
    const prompt = buildFollowUpPrompt(packet);
    const hints = prompt.split('\n').filter(l => l.startsWith('HINT:'));
    const selectHint = hints.find(h => h.includes('SELECT menu'));
    assert.ok(selectHint,
      `Expected a HINT line containing "SELECT menu" when selectMenuDetected is true:\n${prompt}`);
    assert.ok(selectHint!.includes('SELECT:'),
      `SELECT HINT should reference the SELECT: directive format:\n${selectHint}`);
  });

  it('omits SELECT HINT when selectMenuDetected is false or undefined', () => {
    // Test with undefined (default baseFollowUp has no selectMenuDetected)
    const prompt1 = buildFollowUpPrompt(baseFollowUp);
    assert.ok(!prompt1.includes('SELECT menu'),
      `Should NOT include SELECT menu HINT when selectMenuDetected is undefined:\n${prompt1}`);

    // Test with explicit false
    const falsePacket: FollowUpPacket = { ...baseFollowUp, selectMenuDetected: false };
    const prompt2 = buildFollowUpPrompt(falsePacket);
    assert.ok(!prompt2.includes('SELECT menu'),
      `Should NOT include SELECT menu HINT when selectMenuDetected is false:\n${prompt2}`);
  });

  it('SELECT HINT text matches mama prompt HINT', () => {
    // Build mama prompt with selectMenuDetected
    const mamaPacket: ContextPacket = {
      taskDescription: 'Test task',
      workerScreen: 'screen',
      actionLog: { summary: null, recent: [], totalCount: 0 },
      cycleNumber: 1,
      selectMenuDetected: true,
    };
    const mamaPrompt = buildPrompt(mamaPacket);
    const mamaHints = mamaPrompt.split('\n').filter(l => l.startsWith('HINT:') && l.includes('SELECT menu'));
    assert.equal(mamaHints.length, 1, 'mama prompt should have exactly 1 SELECT HINT');

    // Build follow-up prompt with selectMenuDetected
    const followUpPacket: FollowUpPacket = {
      ...baseFollowUp,
      selectMenuDetected: true,
    };
    const followUpPrompt = buildFollowUpPrompt(followUpPacket);
    const followUpHints = followUpPrompt.split('\n').filter(l => l.startsWith('HINT:') && l.includes('SELECT menu'));
    assert.equal(followUpHints.length, 1, 'follow-up prompt should have exactly 1 SELECT HINT');

    // They must be identical
    assert.equal(followUpHints[0], mamaHints[0],
      `SELECT HINT text must be identical between mama and follow-up prompts.\nMama: ${mamaHints[0]}\nFollowUp: ${followUpHints[0]}`);
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
