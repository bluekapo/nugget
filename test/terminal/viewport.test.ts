import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanViewportText } from '../../src/terminal/viewport.js';

describe('cleanViewportText', () => {
  it('collapses consecutive identical separator lines to a single separator', () => {
    const input = [
      'some content',
      '───────────────────',
      '───────────────────',
      '───────────────────',
      'more content',
    ].join('\n');

    const result = cleanViewportText(input);
    const lines = result.split('\n');

    // Should have: content, ONE separator, content
    assert.equal(lines.length, 3, `Expected 3 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.equal(lines[0], 'some content');
    assert.equal(lines[1], '───────────────────');
    assert.equal(lines[2], 'more content');
  });

  it('preserves non-consecutive separator lines separated by content', () => {
    const input = [
      '───────────────────',
      'content between',
      '───────────────────',
    ].join('\n');

    const result = cleanViewportText(input);
    const lines = result.split('\n');

    assert.equal(lines.length, 3, `Expected 3 lines, got ${lines.length}`);
    assert.equal(lines[0], '───────────────────');
    assert.equal(lines[1], 'content between');
    assert.equal(lines[2], '───────────────────');
  });

  it('recognizes lines with box-drawing characters as separators', () => {
    const input = [
      '━━━━━━━━━━',
      '━━━━━━━━━━',
      '═══════════',
      '═══════════',
      '----------',
      '----------',
    ].join('\n');

    const result = cleanViewportText(input);
    const lines = result.split('\n');

    // Each pair of identical separators collapses to one, but different types
    // are also separators so consecutive different-type separators collapse too
    assert.equal(lines.length, 1, `Expected 1 line (all consecutive separators collapse), got ${lines.length}: ${JSON.stringify(lines)}`);
  });

  it('treats timer digit corruption on separator lines as separators', () => {
    const input = [
      '───────────────────',
      '1───2:34───────────',
      '───────────────────',
      'real content here',
    ].join('\n');

    const result = cleanViewportText(input);
    const lines = result.split('\n');

    // All three are separator-like lines (corrupted timer digits mixed with separators)
    assert.equal(lines.length, 2, `Expected 2 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.ok(lines[1].includes('real content here'));
  });

  it('collapses 3+ consecutive blank lines to max 2', () => {
    const input = [
      'line 1',
      '',
      '',
      '',
      '',
      'line 2',
    ].join('\n');

    const result = cleanViewportText(input);
    const lines = result.split('\n');

    // Should have: line 1, blank, blank, line 2
    assert.equal(lines.length, 4, `Expected 4 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.equal(lines[0], 'line 1');
    assert.equal(lines[1], '');
    assert.equal(lines[2], '');
    assert.equal(lines[3], 'line 2');
  });

  it('preserves normal content lines with code, text, and mixed characters unchanged', () => {
    const input = [
      'const x = 42;',
      '  if (foo) { bar(); }',
      '$ npm test -- --grep "pattern"',
      'Hello, World! @#$%^&*()',
    ].join('\n');

    const result = cleanViewportText(input);
    assert.equal(result, input, 'Normal content should pass through unchanged');
  });

  it('passes through input with no artifacts unchanged', () => {
    const input = [
      'first line',
      'second line',
      '',
      'fourth line',
    ].join('\n');

    const result = cleanViewportText(input);
    assert.equal(result, input, 'Clean input should pass through unchanged');
  });

  it('returns empty string for empty input', () => {
    assert.equal(cleanViewportText(''), '');
  });
});
