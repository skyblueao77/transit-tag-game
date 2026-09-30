import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolvePlayerSafetyAction } from '../../src/game/playerSafety.ts';

const emergency = (status, reasonCode = 'OTHER', action = 'EMERGENCY') =>
  resolvePlayerSafetyAction({ action, reasonCode, status });

describe('player Safety Action Core', () => {
  test('allows Emergency from ACTIVE, WAITING, and CAPTURED', () => {
    for (const status of ['ACTIVE', 'WAITING', 'CAPTURED']) {
      assert.deepEqual(emergency(status), {
        allowed: true,
        changed: true,
        status: 'EMERGENCY',
        waitingUntil: 0,
        shinkansenStartTime: null,
        invincibleUntil: 0,
      });
    }
  });

  test('allows Retire from ACTIVE, WAITING, CAPTURED, and EMERGENCY', () => {
    for (const status of ['ACTIVE', 'WAITING', 'CAPTURED', 'EMERGENCY']) {
      assert.equal(emergency(status, 'RETIREMENT_REQUEST', 'RETIRE').status, 'RETIRED');
      assert.equal(emergency(status, 'RETIREMENT_REQUEST', 'RETIRE').changed, true);
    }
  });

  test('returns successful no-op for repeated matching actions', () => {
    assert.deepEqual(emergency('EMERGENCY'), {
      allowed: true,
      changed: false,
      status: 'EMERGENCY',
      waitingUntil: 0,
      shinkansenStartTime: null,
      invincibleUntil: 0,
    });
    assert.equal(emergency('RETIRED', 'RETIREMENT_REQUEST', 'RETIRE').changed, false);
  });

  test('treats RETIRED as terminal for Emergency', () => {
    assert.deepEqual(emergency('RETIRED'), { allowed: false, reason: 'RETIRED_TERMINAL' });
  });

  test('rejects malformed status, action, reason code, and mismatches', () => {
    assert.deepEqual(emergency('UNKNOWN'), { allowed: false, reason: 'INVALID_STATUS' });
    assert.deepEqual(emergency(undefined), { allowed: false, reason: 'INVALID_STATUS' });
    assert.deepEqual(emergency('ACTIVE', 'OTHER', 'UNKNOWN'), { allowed: false, reason: 'INVALID_ACTION' });
    assert.deepEqual(emergency('ACTIVE', 'UNKNOWN'), { allowed: false, reason: 'INVALID_REASON_CODE' });
    assert.deepEqual(emergency('ACTIVE', 'RETIREMENT_REQUEST'), {
      allowed: false, reason: 'REASON_ACTION_MISMATCH',
    });
    assert.deepEqual(emergency('ACTIVE', 'OTHER', 'RETIRE'), {
      allowed: false, reason: 'REASON_ACTION_MISMATCH',
    });
  });

  test('does not mutate input', () => {
    const input = { action: 'EMERGENCY', reasonCode: 'OTHER', status: 'WAITING' };
    const before = structuredClone(input);
    resolvePlayerSafetyAction(input);
    assert.deepEqual(input, before);
  });
});
