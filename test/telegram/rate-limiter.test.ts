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

  describe('backoff', () => {
    it('mandatory send returns false during backoff window', () => {
      mock.timers.setTime(1000);
      limiter.notifyBackoff(5); // backoff until 6000

      mock.timers.setTime(3000);
      assert.equal(limiter.canSend(true), false);
    });

    it('deferrable send returns false during backoff window', () => {
      mock.timers.setTime(1000);
      limiter.notifyBackoff(5); // backoff until 6000

      mock.timers.setTime(3000);
      assert.equal(limiter.canSend(false), false);
    });

    it('mandatory send returns true after backoff expires', () => {
      mock.timers.setTime(1000);
      limiter.notifyBackoff(5); // backoff until 6000

      mock.timers.setTime(6001);
      assert.equal(limiter.canSend(true), true);
    });

    it('deferrable send resumes normal interval logic after backoff expires', () => {
      mock.timers.setTime(1000);
      limiter.notifyBackoff(5); // backoff until 6000

      mock.timers.setTime(7000); // well past backoff, no prior recordSend
      assert.equal(limiter.canSend(false), true);
    });

    it('isInBackoff returns true during backoff, false after', () => {
      mock.timers.setTime(1000);
      limiter.notifyBackoff(5);

      mock.timers.setTime(3000);
      assert.equal(limiter.isInBackoff(), true);

      mock.timers.setTime(6001);
      assert.equal(limiter.isInBackoff(), false);
    });

    it('longer backoff extends existing shorter backoff', () => {
      mock.timers.setTime(1000);
      limiter.notifyBackoff(5); // backoff until 6000

      mock.timers.setTime(2000);
      limiter.notifyBackoff(10); // backoff until 12000 (longer)

      mock.timers.setTime(6001); // past first backoff but within second
      assert.equal(limiter.canSend(true), false);
      assert.equal(limiter.isInBackoff(), true);

      mock.timers.setTime(12001);
      assert.equal(limiter.canSend(true), true);
      assert.equal(limiter.isInBackoff(), false);
    });

    it('shorter backoff does not shorten existing longer backoff', () => {
      mock.timers.setTime(1000);
      limiter.notifyBackoff(10); // backoff until 11000

      mock.timers.setTime(2000);
      limiter.notifyBackoff(3); // would be until 5000, but 11000 is longer

      mock.timers.setTime(5001); // past shorter backoff
      assert.equal(limiter.canSend(true), false);
      assert.equal(limiter.isInBackoff(), true);

      mock.timers.setTime(11001);
      assert.equal(limiter.canSend(true), true);
    });

    it('notifyBackoff(0) is a no-op', () => {
      mock.timers.setTime(1000);
      limiter.notifyBackoff(0);

      assert.equal(limiter.isInBackoff(), false);
      assert.equal(limiter.canSend(true), true);
    });

    it('notifyBackoff with negative value is a no-op', () => {
      mock.timers.setTime(1000);
      limiter.notifyBackoff(-5);

      assert.equal(limiter.isInBackoff(), false);
      assert.equal(limiter.canSend(false), true);
    });

    it('existing interval tests still pass with no backoff active', () => {
      // This test verifies that the backoff addition doesn't regress interval logic.
      // canSend(false) should still respect interval when no backoff is active.
      mock.timers.setTime(1000);
      limiter.recordSend();

      mock.timers.setTime(1500);
      assert.equal(limiter.canSend(false), false); // within interval

      mock.timers.setTime(2000);
      assert.equal(limiter.canSend(false), true); // past interval
    });
  });
});
