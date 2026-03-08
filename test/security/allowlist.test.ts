import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandAllowlist } from '../../src/security/allowlist.js';

describe('CommandAllowlist', () => {
  describe('disabled mode', () => {
    it('allows anything when config is undefined', () => {
      const al = new CommandAllowlist(undefined);
      assert.equal(al.isAllowed('anything'), true);
    });

    it('allows anything when config is "*"', () => {
      const al = new CommandAllowlist('*');
      assert.equal(al.isAllowed('anything'), true);
    });
  });

  describe('exact match', () => {
    it('allows commands in the comma-separated list', () => {
      const al = new CommandAllowlist('/clear,/compact');
      assert.equal(al.isAllowed('/clear'), true);
    });

    it('rejects commands not in the list', () => {
      const al = new CommandAllowlist('/clear,/compact');
      assert.equal(al.isAllowed('rm -rf /'), false);
    });
  });

  describe('glob wildcard', () => {
    it('allows commands matching glob pattern', () => {
      const al = new CommandAllowlist('/gsd:*');
      assert.equal(al.isAllowed('/gsd:execute'), true);
    });

    it('rejects commands not matching glob pattern', () => {
      const al = new CommandAllowlist('/gsd:*');
      assert.equal(al.isAllowed('/other'), false);
    });
  });

  describe('short commands', () => {
    it('allows short single-char commands', () => {
      const al = new CommandAllowlist('y,n,yes,no');
      assert.equal(al.isAllowed('y'), true);
    });
  });

  describe('case insensitivity', () => {
    it('matches case-insensitively', () => {
      const al = new CommandAllowlist('/Clear');
      assert.equal(al.isAllowed('/clear'), true);
    });
  });

  describe('trimming', () => {
    it('trims input before matching', () => {
      const al = new CommandAllowlist('/clear');
      assert.equal(al.isAllowed('  /clear  '), true);
    });
  });

  describe('describe()', () => {
    it('returns "*" when disabled', () => {
      const al = new CommandAllowlist(undefined);
      assert.equal(al.describe(), '*');
    });

    it('returns pattern descriptions when enabled', () => {
      const al = new CommandAllowlist('/clear,/compact');
      const desc = al.describe();
      assert.ok(desc.includes('/clear'));
      assert.ok(desc.includes('/compact'));
    });
  });

  describe('empty patterns', () => {
    it('filters out empty string patterns', () => {
      const al = new CommandAllowlist(',,,');
      assert.equal(al.isAllowed('test'), false);
    });
  });
});
