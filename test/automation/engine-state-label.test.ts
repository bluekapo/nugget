import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { engineStateLabel } from '../../src/automation/engine.js';

describe('engineStateLabel', () => {
  it('maps idle to Working...', () => {
    assert.equal(engineStateLabel('idle'), 'Working...');
  });

  it('maps executing to Executing directive', () => {
    assert.equal(engineStateLabel('executing'), 'Executing directive');
  });

  it('maps waiting-response to Waiting for response', () => {
    assert.equal(engineStateLabel('waiting-response'), 'Waiting for response');
  });

  it('maps paused to Paused', () => {
    assert.equal(engineStateLabel('paused'), 'Paused');
  });

  it('maps stopped to Stopped', () => {
    assert.equal(engineStateLabel('stopped'), 'Stopped');
  });

  it('maps capturing-worker to Capturing worker output', () => {
    assert.equal(engineStateLabel('capturing-worker'), 'Capturing worker output');
  });

  it('maps clearing-orchestrator to Preparing orchestrator', () => {
    assert.equal(engineStateLabel('clearing-orchestrator'), 'Preparing orchestrator');
  });

  it('maps clearing-worker to Preparing worker', () => {
    assert.equal(engineStateLabel('clearing-worker'), 'Preparing worker');
  });

  it('maps prompting-orchestrator to Prompting orchestrator', () => {
    assert.equal(engineStateLabel('prompting-orchestrator'), 'Prompting orchestrator');
  });

  it('maps consulting-orchestrator to Consulting orchestrator', () => {
    assert.equal(engineStateLabel('consulting-orchestrator'), 'Consulting orchestrator');
  });

  it('maps waiting-consultation to Waiting for consultation', () => {
    assert.equal(engineStateLabel('waiting-consultation'), 'Waiting for consultation');
  });

  it('maps consultation-wait to Waiting for consultation', () => {
    assert.equal(engineStateLabel('consultation-wait'), 'Waiting for consultation');
  });

  it('returns unknown strings as-is (fallback)', () => {
    assert.equal(engineStateLabel('some-unknown-state'), 'some-unknown-state');
  });
});
