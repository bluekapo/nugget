import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ownerOnly } from '../../src/telegram/auth.js';

describe('ownerOnly middleware', () => {
  it('calls next() when ctx.from.id matches ownerId', async () => {
    const middleware = ownerOnly(123);
    let nextCalled = false;
    const ctx = { from: { id: 123 } };
    const next = async () => { nextCalled = true; };

    await middleware(ctx as any, next);
    assert.equal(nextCalled, true, 'next() should have been called for the owner');
  });

  it('does NOT call next() when ctx.from.id does not match ownerId', async () => {
    const middleware = ownerOnly(123);
    let nextCalled = false;
    const ctx = { from: { id: 456 } };
    const next = async () => { nextCalled = true; };

    await middleware(ctx as any, next);
    assert.equal(nextCalled, false, 'next() should NOT be called for non-owner');
  });

  it('does NOT call next() when ctx.from is undefined', async () => {
    const middleware = ownerOnly(123);
    let nextCalled = false;
    const ctx = {};
    const next = async () => { nextCalled = true; };

    await middleware(ctx as any, next);
    assert.equal(nextCalled, false, 'next() should NOT be called when ctx.from is undefined');
  });

  it('returns void (silent drop) for non-owner', async () => {
    const middleware = ownerOnly(123);
    const ctx = { from: { id: 789 } };
    const next = async () => {};

    const result = await middleware(ctx as any, next);
    assert.equal(result, undefined, 'Should return undefined (silent drop)');
  });
});
