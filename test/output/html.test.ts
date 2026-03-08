import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wrapPre } from '../../src/output/html.js';

describe('wrapPre', () => {
  it('wraps text in pre tags', () => {
    assert.equal(wrapPre('hello'), '<pre>hello</pre>');
  });

  it('escapes ampersand', () => {
    assert.equal(wrapPre('a & b'), '<pre>a &amp; b</pre>');
  });

  it('escapes angle brackets', () => {
    assert.equal(wrapPre('<div>'), '<pre>&lt;div&gt;</pre>');
  });

  it('escapes all special chars together', () => {
    assert.equal(wrapPre('<a href="x">&</a>'), '<pre>&lt;a href="x"&gt;&amp;&lt;/a&gt;</pre>');
  });

  it('passes text without special chars unchanged', () => {
    assert.equal(wrapPre('hello world'), '<pre>hello world</pre>');
  });

  it('handles empty string', () => {
    assert.equal(wrapPre(''), '<pre></pre>');
  });

  it('preserves backtick characters (no interference with Telegram code formatting)', () => {
    assert.equal(wrapPre('`code`'), '<pre>`code`</pre>');
  });

  it('preserves multiple consecutive newlines in pre block', () => {
    assert.equal(wrapPre('line1\n\n\nline2'), '<pre>line1\n\n\nline2</pre>');
  });

  it('preserves leading and trailing whitespace in pre block', () => {
    assert.equal(wrapPre('  indented  '), '<pre>  indented  </pre>');
  });

  it('correctly double-escapes already-escaped-looking text', () => {
    // Input contains literal "&amp;" -- the & should be escaped to &amp;
    // producing "&amp;amp;" in output
    assert.equal(wrapPre('&amp;'), '<pre>&amp;amp;</pre>');
  });

  it('handles text with mixed special chars, backticks, and newlines', () => {
    const input = '`func()` -> <T> & done\n\nnext';
    const expected = '<pre>`func()` -&gt; &lt;T&gt; &amp; done\n\nnext</pre>';
    assert.equal(wrapPre(input), expected);
  });
});
