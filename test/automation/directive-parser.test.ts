import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirective } from '../../src/automation/directive-parser.js';

describe('parseDirective', () => {
  describe('COMMAND directive', () => {
    it('extracts command string from COMMAND: line', () => {
      const result = parseDirective('some output\nCOMMAND: npm test\nmore output');
      assert.deepStrictEqual(result, { type: 'COMMAND', command: 'npm test' });
    });

    it('preserves special characters (pipes, flags) in command', () => {
      const result = parseDirective('output\nCOMMAND: git log --oneline | head -5\nend');
      assert.deepStrictEqual(result, {
        type: 'COMMAND',
        command: 'git log --oneline | head -5',
      });
    });
  });

  describe('SELECT directive', () => {
    it('extracts 1-based option number', () => {
      const result = parseDirective('menu items\nSELECT: 3\ndone');
      assert.deepStrictEqual(result, { type: 'SELECT', option: 3 });
    });

    it('returns null for option 0 (invalid)', () => {
      const result = parseDirective('menu items\nSELECT: 0\ndone');
      assert.strictEqual(result, null);
    });
  });

  describe('ENTER directive', () => {
    it('returns ENTER type with no parameters', () => {
      const result = parseDirective('waiting for input\nENTER\nprompt');
      assert.deepStrictEqual(result, { type: 'ENTER' });
    });
  });

  describe('WAIT directive', () => {
    it('returns WAIT without delaySeconds when bare WAIT', () => {
      const result = parseDirective('processing\nWAIT\nstill going');
      assert.deepStrictEqual(result, { type: 'WAIT' });
    });

    it('returns WAIT with delaySeconds when WAIT: N given', () => {
      const result = parseDirective('processing\nWAIT: 30\nstill going');
      assert.deepStrictEqual(result, { type: 'WAIT', delaySeconds: 30 });
    });
  });

  describe('ESCALATE directive', () => {
    it('extracts reason string', () => {
      const result = parseDirective('output\nESCALATE: Task appears complete\nend');
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
  });

  describe('last-match scanning', () => {
    it('returns the bottom directive when multiple appear in text', () => {
      const screenText = [
        'Respond with COMMAND: <text to type>',  // prompt echo at top
        'Some thinking...',
        'Tool call output...',
        '',
        'COMMAND: npm run build',  // actual directive at bottom
      ].join('\n');
      const result = parseDirective(screenText);
      assert.deepStrictEqual(result, { type: 'COMMAND', command: 'npm run build' });
    });
  });

  describe('whitespace handling', () => {
    it('parses correctly with leading/trailing whitespace', () => {
      const result = parseDirective('  COMMAND: npm test  ');
      assert.deepStrictEqual(result, { type: 'COMMAND', command: 'npm test' });
    });
  });

  describe('empty/blank lines', () => {
    it('finds directive in text with blank lines between content', () => {
      const screenText = [
        'some output',
        '',
        '',
        'ESCALATE: Something went wrong',
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
});
