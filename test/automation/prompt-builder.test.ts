import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../../src/automation/prompt-builder.js';
import type { ContextPacket } from '../../src/automation/types.js';

describe('buildPrompt', () => {
  const basePacket: ContextPacket = {
    taskDescription: 'Run the test suite and fix any failures',
    workerScreen: '$ npm test\n\nAll 42 tests passed.',
    actionLog: [
      { action: 'COMMAND: npm test', outcome: 'Tests executed successfully', timestamp: 1700000000000 },
      { action: 'COMMAND: npm run lint', outcome: 'No lint errors found', timestamp: 1700000010000 },
    ],
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

  it('output contains action log entries with "Sent:" and "Result:" labels', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(prompt.includes('Sent: COMMAND: npm test'), `Expected "Sent:" label in prompt`);
    assert.ok(prompt.includes('Result: Tests executed successfully'), `Expected "Result:" label in prompt`);
    assert.ok(prompt.includes('Sent: COMMAND: npm run lint'), `Expected second "Sent:" label in prompt`);
    assert.ok(prompt.includes('Result: No lint errors found'), `Expected second "Result:" label in prompt`);
  });

  it('with empty action log shows "(no actions taken yet" message', () => {
    const emptyPacket: ContextPacket = {
      taskDescription: 'Do something',
      workerScreen: '$ _',
      actionLog: [],
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

  it('output contains all 5 directive types (COMMAND, SELECT, ENTER, WAIT, ESCALATE)', () => {
    const prompt = buildPrompt(basePacket);
    assert.ok(prompt.includes('COMMAND'), 'Expected COMMAND directive type');
    assert.ok(prompt.includes('SELECT'), 'Expected SELECT directive type');
    assert.ok(prompt.includes('ENTER'), 'Expected ENTER directive type');
    assert.ok(prompt.includes('WAIT'), 'Expected WAIT directive type');
    assert.ok(prompt.includes('ESCALATE'), 'Expected ESCALATE directive type');
  });

  it('output contains escalation guideline (use ESCALATE when task complete or unsure)', () => {
    const prompt = buildPrompt(basePacket);
    const lower = prompt.toLowerCase();
    assert.ok(
      lower.includes('escalate') && (lower.includes('complete') || lower.includes('unsure') || lower.includes('went wrong')),
      `Expected escalation guideline in prompt:\n${prompt}`
    );
  });
});
