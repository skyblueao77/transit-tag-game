import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  resumeExpiredWaiting,
  startManualWaiting,
  startShinkansenLimitWaiting,
} from '../../src/game/waitingLifecycle.ts';
import {
  SHINKANSEN_LIMIT_DURATION_MS,
  SHINKANSEN_WAIT_DURATION_MS,
} from '../../src/game/time.ts';

const now = 1_800_000_000_000;

function input(overrides = {}) {
  return {
    status: 'ACTIVE',
    phase: 'DAY1_ACTIVE',
    role: 'RUNNER',
    waitingUntil: 0,
    shinkansenStartTime: null,
    now,
    ...overrides,
  };
}

describe('Waiting lifecycle Core', () => {
  test('starts manual Waiting for an active Runner in every allowed phase', () => {
    for (const phase of ['DAY1_ACTIVE', 'DAY2_ACTIVE', 'FINAL_MISSION']) {
      const result = startManualWaiting(input({ phase }));
      assert.deepEqual(result, {
        allowed: true,
        changed: true,
        action: 'MANUAL',
        status: 'WAITING',
        waitingUntil: now + SHINKANSEN_WAIT_DURATION_MS,
        shinkansenStartTime: null,
        duration: SHINKANSEN_WAIT_DURATION_MS,
      });
    }
  });

  test('rejects ONI, non-ACTIVE, disallowed phase, and malformed Waiting state', () => {
    assert.deepEqual(startManualWaiting(input({ role: 'ONI' })), { allowed: false, reason: 'WRONG_ROLE' });
    assert.deepEqual(startManualWaiting(input({ status: 'WAITING' })), { allowed: false, reason: 'INVALID_STATUS' });
    assert.deepEqual(startManualWaiting(input({ status: 'EMERGENCY' })), { allowed: false, reason: 'INVALID_STATUS' });
    assert.deepEqual(startManualWaiting(input({ phase: 'DAY1_PAUSED' })), { allowed: false, reason: 'PHASE' });
    assert.deepEqual(startManualWaiting(input({ phase: 'UNKNOWN' })), { allowed: false, reason: 'INVALID_PHASE' });
    assert.deepEqual(startManualWaiting(input({ waitingUntil: now + 1 })), { allowed: false, reason: 'INVALID_WAITING_STATE' });
    assert.deepEqual(startManualWaiting(input({ shinkansenStartTime: 'later' })), { allowed: false, reason: 'INVALID_WAITING_STATE' });
  });

  test('uses exact existing 60-minute duration, clears train timestamp, and does not mutate input', () => {
    const value = input({ shinkansenStartTime: now - 100 });
    const before = structuredClone(value);
    const result = startManualWaiting(value);
    assert.equal(result.allowed, true);
    assert.equal(result.waitingUntil, now + SHINKANSEN_WAIT_DURATION_MS);
    assert.equal(result.shinkansenStartTime, null);
    assert.deepEqual(value, before);
  });

  test('Shinkansen limit is strictly exceeded, including exact-boundary rejection', () => {
    const start = now - SHINKANSEN_LIMIT_DURATION_MS;
    assert.deepEqual(startShinkansenLimitWaiting(input({ shinkansenStartTime: start + 1 })), {
      allowed: false, reason: 'SHINKANSEN_LIMIT_NOT_REACHED',
    });
    assert.deepEqual(startShinkansenLimitWaiting(input({ shinkansenStartTime: start })), {
      allowed: false, reason: 'SHINKANSEN_LIMIT_NOT_REACHED',
    });
    const value = input({ shinkansenStartTime: start - 1 });
    const before = structuredClone(value);
    const result = startShinkansenLimitWaiting(value);
    assert.deepEqual(value, before);
    assert.equal(result.allowed, true);
    assert.equal(result.action, 'SHINKANSEN_LIMIT');
    assert.equal(result.waitingUntil, now + SHINKANSEN_WAIT_DURATION_MS);
    assert.equal(result.shinkansenStartTime, null);
  });

  test('Shinkansen limit rejects malformed status, phase, and missing or invalid timestamps', () => {
    assert.deepEqual(startShinkansenLimitWaiting(input({ status: 'WAITING', shinkansenStartTime: now - 1 })), {
      allowed: false, reason: 'INVALID_STATUS',
    });
    assert.deepEqual(startShinkansenLimitWaiting(input({ phase: 'GAME_OVER', shinkansenStartTime: now - 1 })), {
      allowed: false, reason: 'PHASE',
    });
    assert.deepEqual(startShinkansenLimitWaiting(input()), { allowed: false, reason: 'INVALID_SHINKANSEN_START' });
    assert.deepEqual(startShinkansenLimitWaiting(input({ shinkansenStartTime: Number.NaN })), {
      allowed: false, reason: 'INVALID_WAITING_STATE',
    });
  });

  test('resumes at the exact deadline and normalizes Waiting fields', () => {
    for (const at of [now, now + 1]) {
      const value = input({
        status: 'WAITING',
        waitingUntil: now,
        shinkansenStartTime: now - 1,
        now: at,
      });
      const before = structuredClone(value);
      assert.deepEqual(resumeExpiredWaiting(value), {
        allowed: true,
        changed: true,
        action: 'RESUME',
        status: 'ACTIVE',
        waitingUntil: 0,
        shinkansenStartTime: null,
        duration: 0,
      });
      assert.deepEqual(value, before);
    }
  });

  test('does not resume early, malformed Waiting, Emergency, or Retired players', () => {
    assert.deepEqual(resumeExpiredWaiting(input({ status: 'WAITING', waitingUntil: now + 1 })), {
      allowed: false, reason: 'WAITING_NOT_EXPIRED',
    });
    assert.deepEqual(resumeExpiredWaiting(input({ status: 'WAITING', waitingUntil: undefined })), {
      allowed: false, reason: 'INVALID_WAITING_DEADLINE',
    });
    for (const status of ['EMERGENCY', 'RETIRED', 'CAPTURED']) {
      assert.deepEqual(resumeExpiredWaiting(input({ status })), { allowed: false, reason: 'NOT_WAITING' });
    }
  });

  test('already ACTIVE is a successful no-op and all operations preserve their inputs', () => {
    const value = input();
    const before = structuredClone(value);
    assert.deepEqual(resumeExpiredWaiting(value), {
      allowed: true,
      changed: false,
      action: 'RESUME',
      status: 'ACTIVE',
      waitingUntil: 0,
      shinkansenStartTime: null,
      duration: 0,
    });
    assert.deepEqual(value, before);
    assert.deepEqual(resumeExpiredWaiting(input({ status: 'ACTIVE', waitingUntil: now + 1 })), {
      allowed: false, reason: 'INVALID_WAITING_STATE',
    });
  });

  test('supports custom dynamic waiting duration and shinkansen segment limit', () => {
    // Custom wait duration: 30 minutes (1,800,000 ms) instead of default 60 minutes
    const customWaitMs = 30 * 60 * 1000;
    const manualResult = startManualWaiting(input({ shinkansenWaitDurationMs: customWaitMs }));
    assert.equal(manualResult.allowed, true);
    assert.equal(manualResult.duration, customWaitMs);
    assert.equal(manualResult.waitingUntil, now + customWaitMs);

    // Shinkansen segment limit reached (e.g. limit 3 segments, player at 3 segments)
    const segmentResult = startShinkansenLimitWaiting(input({
      shinkansenStartTime: now - 1000, // Not yet reached time limit (only 1s elapsed)
      shinkansenSegmentCount: 3,
      shinkansenMaxSegments: 3,
      shinkansenWaitDurationMs: customWaitMs,
    }));
    assert.equal(segmentResult.allowed, true);
    assert.equal(segmentResult.action, 'SHINKANSEN_LIMIT');
    assert.equal(segmentResult.duration, customWaitMs);
    assert.equal(segmentResult.waitingUntil, now + customWaitMs);

    // Shinkansen segment limit not reached (limit 3, player at 2) and time not reached
    const notReachedResult = startShinkansenLimitWaiting(input({
      shinkansenStartTime: now - 1000,
      shinkansenSegmentCount: 2,
      shinkansenMaxSegments: 3,
    }));
    assert.deepEqual(notReachedResult, { allowed: false, reason: 'SHINKANSEN_LIMIT_NOT_REACHED' });
  });
});

