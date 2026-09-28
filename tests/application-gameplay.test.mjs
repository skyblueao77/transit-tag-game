import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  activateInvincibility,
  capturePlayer,
  completeMission,
} from '../src/application/index.ts';


function missionGateway(result) {
  const calls = [];
  return {
    calls,
    completeMission: async input => {
      calls.push(structuredClone(input));
      return result;
    },
  };
}


const missionInput = overrides => ({ missionId: 'mission-1', ...overrides });

const missionSuccess = overrides => ({
  ok: true,
  missionId: 'mission-1',
  reward: { missionId: 'mission-1', points: 25, isFinalMission: false },
  score: {
    teamScoreDelta: 25,
    playerScoreDelta: 25,
    invincibleCardDelta: 0,
    luckyReward: false,
  },
  isFinalMission: false,
  ...overrides,
});

function player(id, team, overrides = {}) {
  return { id, team, status: 'ACTIVE', invincibleCards: 0, ...overrides };
}


describe('completeMission application use case', () => {
  test('forwards only missionId and returns the trusted gateway result', async () => {
    const result = missionSuccess({
      score: {
        teamScoreDelta: 25,
        playerScoreDelta: 25,
        invincibleCardDelta: 1,
        luckyReward: true,
      },
    });
    const gateway = missionGateway(result);
    const input = missionInput();
    const before = structuredClone(input);

    assert.deepEqual(await completeMission(input, gateway), result);
    assert.deepEqual(gateway.calls, [{ missionId: 'mission-1' }]);
    assert.deepEqual(input, before);
  });

  test('preserves server determination of a final mission result', async () => {
    const result = missionSuccess({
      missionId: 'final-1',
      reward: { missionId: 'final-1', points: 100, isFinalMission: true },
      isFinalMission: true,
    });
    const gateway = missionGateway(result);

    assert.deepEqual(await completeMission({ missionId: 'final-1' }, gateway), result);
    assert.deepEqual(gateway.calls, [{ missionId: 'final-1' }]);
  });

  test('preserves callable domain rejections', async () => {
    const gateway = missionGateway({ ok: false, reason: 'ALREADY_COMPLETED' });
    assert.deepEqual(await completeMission(missionInput(), gateway), {
      ok: false, reason: 'ALREADY_COMPLETED',
    });
  });

  test('maps unexpected gateway failures to persistence errors', async () => {
    const gateway = { completeMission: async () => { throw new Error('offline'); } };
    assert.deepEqual(await completeMission(missionInput(), gateway), {
      ok: false, reason: 'PERSISTENCE_ERROR',
    });
  });
});

describe('capturePlayer application use case', () => {
  test('forwards only the explicit targetId and returns the trusted gateway result', async () => {
    const calls = [];
    const capture = {
      allowed: true,
      reward: { team: 'A', scoreDelta: 50 },
      teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
      playerChanges: [],
      nextRevealTime: 1_900_000,
      waitingDuration: 1_800_000,
      event: { type: 'CAPTURE', captorId: 'server-captor', targetId: 'runner-1' },
    };
    const gateway = {
      capture: async input => {
        calls.push(structuredClone(input));
        return { ok: true, capture };
      },
    };
    const input = { targetId: 'runner-1' };
    const before = structuredClone(input);

    assert.deepEqual(await capturePlayer(input, gateway), { ok: true, capture });
    assert.deepEqual(calls, [{ targetId: 'runner-1' }]);
    assert.deepEqual(input, before);
  });

  test('preserves server domain rejections', async () => {
    const gateway = {
      capture: async () => ({
        ok: false,
        reason: 'CAPTURE_REJECTED',
        domainReason: 'TARGET_INVINCIBLE',
      }),
    };
    assert.deepEqual(await capturePlayer({ targetId: 'runner-1' }, gateway), {
      ok: false, reason: 'CAPTURE_REJECTED', domainReason: 'TARGET_INVINCIBLE',
    });
  });

  test('maps unexpected gateway failures to persistence errors', async () => {
    const gateway = { capture: async () => { throw new Error('offline'); } };
    assert.deepEqual(await capturePlayer({ targetId: 'runner-1' }, gateway), {
      ok: false, reason: 'PERSISTENCE_ERROR',
    });
  });
});

describe('activateInvincibility application use case', () => {
  test('sends an empty intent without client authority values', async () => {
    const calls = [];
    const trustedResult = {
      ok: true,
      remainingCards: 1,
      invincibleUntil: 1_801_000,
      duration: 1_800_000,
    };
    const gateway = {
      activate: async input => {
        calls.push(structuredClone(input));
        return trustedResult;
      },
    };

    assert.deepEqual(await activateInvincibility({}, gateway), trustedResult);
    assert.deepEqual(calls, [{}]);
  });

  test('returns the trusted server result unchanged', async () => {
    const trustedResult = {
      ok: true,
      remainingCards: 0,
      invincibleUntil: 2_500_000,
      duration: 1_800_000,
    };
    const gateway = { activate: async () => trustedResult };
    assert.deepEqual(await activateInvincibility({}, gateway), trustedResult);
  });

  test('preserves server domain rejection', async () => {
    const rejection = { ok: false, reason: 'POWERUP_NOT_ALLOWED', domainReason: 'PHASE' };
    const gateway = { activate: async () => rejection };
    assert.deepEqual(await activateInvincibility({}, gateway), rejection);
  });

  test('maps unexpected gateway failures to persistence errors', async () => {
    const gateway = { activate: async () => { throw new Error('offline'); } };
    assert.deepEqual(await activateInvincibility({}, gateway), {
      ok: false, reason: 'PERSISTENCE_ERROR',
    });
  });
});
