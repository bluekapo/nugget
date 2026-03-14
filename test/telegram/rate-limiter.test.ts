import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../../src/telegram/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
    mock.timers.enable({ apis: ['Date'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('mandatory send always returns true even immediately after a previous send', () => {
    mock.timers.setTime(1000);
    limiter.recordSend();

    // 0ms elapsed -- mandatory should still pass
    assert.equal(limiter.canSend(true), true);
  });

  it('first deferrable send returns true (no prior sends)', () => {
    mock.timers.setTime(5000);
    assert.equal(limiter.canSend(false), true);
  });

  it('deferrable send within 1000ms of last send returns false', () => {
    mock.timers.setTime(1000);
    limiter.recordSend();

    mock.timers.setTime(1500); // 500ms later
    assert.equal(limiter.canSend(false), false);
  });

  it('deferrable send at exactly 1000ms after last send returns true', () => {
    mock.timers.setTime(1000);
    limiter.recordSend();

    mock.timers.setTime(2000); // exactly 1000ms later
    assert.equal(limiter.canSend(false), true);
  });

  it('recordSend updates the timestamp used by subsequent canSend checks', () => {
    mock.timers.setTime(1000);
    limiter.recordSend();

    mock.timers.setTime(2000); // 1000ms later -- would pass
    limiter.recordSend();       // but we record again

    mock.timers.setTime(2500); // only 500ms after second send
    assert.equal(limiter.canSend(false), false);

    mock.timers.setTime(3000); // 1000ms after second send
    assert.equal(limiter.canSend(false), true);
  });

  it('custom interval (500ms) is respected', () => {
    const fast = new RateLimiter(500);

    mock.timers.setTime(1000);
    fast.recordSend();

    mock.timers.setTime(1400); // 400ms -- too soon
    assert.equal(fast.canSend(false), false);

    mock.timers.setTime(1500); // 500ms -- exactly right
    assert.equal(fast.canSend(false), true);
  });

  it('multiple rapid deferrable sends -- only first passes, rest are dropped', () => {
    mock.timers.setTime(1000);
    // First deferrable should pass (no prior sends)
    assert.equal(limiter.canSend(false), true);
    limiter.recordSend();

    // Rapid subsequent sends within the window
    mock.timers.setTime(1100);
    assert.equal(limiter.canSend(false), false);

    mock.timers.setTime(1200);
    assert.equal(limiter.canSend(false), false);

    mock.timers.setTime(1500);
    assert.equal(limiter.canSend(false), false);

    mock.timers.setTime(1999);
    assert.equal(limiter.canSend(false), false);

    // After the interval, it passes again
    mock.timers.setTime(2000);
    assert.equal(limiter.canSend(false), true);
  });
});
