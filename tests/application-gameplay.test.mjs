import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  activateInvincibility,
  capturePlayer,
  completeMission,
} from '../src/application/index.ts';
import { INVINCIBILITY_DURATION_MS } from '../src/game/time.ts';

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

function captureStore() {
  const calls = [];
  return {
    calls,
    applyCapture: async result => calls.push(structuredClone(result)),
  };
}

function powerupStore() {
  const calls = [];
  return {
    calls,
    applyInvincibility: async input => calls.push(structuredClone(input)),
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

const captureInput = overrides => ({
  captorId: 'oni-1',
  targetId: 'runner-1',
  players: [player('oni-1', 'A'), player('runner-1', 'B')],
  teamRoles: { teamARole: 'ONI', teamBRole: 'RUNNER' },
  phase: 'DAY1_ACTIVE',
  now: 1_000_000,
  ...overrides,
});

const powerupInput = overrides => ({
  playerId: 'runner-1',
  role: 'RUNNER',
  cards: 2,
  phase: 'DAY1_ACTIVE',
  now: 1_000_000,
  ...overrides,
});

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
  test('persists exactly once for the explicitly supplied target', async () => {
    const store = captureStore();
    const result = await capturePlayer(captureInput(), store);

    assert.equal(result.ok, true);
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0].event.targetId, 'runner-1');
    assert.deepEqual(result.capture, store.calls[0]);
  });

  test('rejects invalid, invincible, and same-player captures without persistence', async () => {
    const cases = [
      [captureInput({ phase: 'DAY1_PAUSED' }), 'PHASE'],
      [captureInput({ players: [player('oni-1', 'A'), player('runner-1', 'B', { status: 'WAITING' })] }), 'TARGET_STATUS'],
      [captureInput({ players: [player('oni-1', 'A'), player('runner-1', 'B', { invincibleUntil: 1_000_001 })] }), 'TARGET_INVINCIBLE'],
      [captureInput({ targetId: 'oni-1' }), 'SAME_PLAYER'],
    ];
    for (const [input, expectedReason] of cases) {
      const store = captureStore();
      const result = await capturePlayer(input, store);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'CAPTURE_REJECTED');
      assert.equal(result.domainReason, expectedReason);
      assert.equal(store.calls.length, 0);
    }
  });

  test('preserves Core reward, role changes, player changes, deadline, and event', async () => {
    const store = captureStore();
    const result = await capturePlayer(captureInput({
      players: [player('oni-1', 'A'), player('oni-2', 'A'), player('runner-1', 'B')],
    }), store);

    assert.equal(result.ok, true);
    assert.deepEqual(result.capture.reward, { team: 'A', scoreDelta: 50 });
    assert.deepEqual(result.capture.teamRoles, { teamARole: 'RUNNER', teamBRole: 'ONI' });
    assert.equal(result.capture.nextRevealTime, 1_000_000 + 30 * 60 * 1000);
    assert.deepEqual(result.capture.event, {
      type: 'CAPTURE', captorId: 'oni-1', targetId: 'runner-1',
    });
    assert.deepEqual(result.capture.playerChanges, [
      { playerId: 'oni-1', status: 'ACTIVE', waitingUntil: 0, invincibleCardsDelta: 1 },
      { playerId: 'oni-2', status: 'ACTIVE', waitingUntil: 0, invincibleCardsDelta: 1 },
      {
        playerId: 'runner-1', status: 'WAITING', waitingUntil: 1_000_000 + 30 * 60 * 1000,
        invincibleUntil: 0, invincibleCardsDelta: 0,
      },
    ]);
    assert.deepEqual(store.calls[0], result.capture);
  });

  test('does not mutate input players', async () => {
    const input = captureInput();
    const before = structuredClone(input.players);
    await capturePlayer(input, captureStore());
    assert.deepEqual(input.players, before);
  });

  test('returns persistence errors separately', async () => {
    const store = { applyCapture: async () => { throw new Error('offline'); } };
    assert.deepEqual(await capturePlayer(captureInput(), store), {
      ok: false, reason: 'PERSISTENCE_ERROR',
    });
  });
});

describe('activateInvincibility application use case', () => {
  test('persists the Core card delta and calculated expiration', async () => {
    const store = powerupStore();
    const result = await activateInvincibility(powerupInput(), store);

    assert.equal(result.ok, true);
    assert.equal(result.activation.cardDelta, -1);
    assert.equal(result.activation.invincibleUntil, 1_000_000 + INVINCIBILITY_DURATION_MS);
    assert.deepEqual(store.calls, [{
      playerId: 'runner-1',
      cardDelta: -1,
      invincibleUntil: 1_000_000 + INVINCIBILITY_DURATION_MS,
    }]);
  });

  test('rejects ONI, zero cards, denied phase, and already-active state', async () => {
    const cases = [
      [powerupInput({ role: 'ONI' }), 'ROLE'],
      [powerupInput({ cards: 0 }), 'NO_CARDS'],
      [powerupInput({ phase: 'DAY1_PAUSED' }), 'PHASE'],
      [powerupInput({ invincibleUntil: 1_000_001 }), 'ALREADY_ACTIVE'],
    ];
    for (const [input, expectedReason] of cases) {
      const store = powerupStore();
      const result = await activateInvincibility(input, store);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'INVINCIBILITY_REJECTED');
      assert.equal(result.domainReason, expectedReason);
      assert.equal(store.calls.length, 0);
    }
  });

  test('returns persistence errors separately', async () => {
    const store = { applyInvincibility: async () => { throw new Error('offline'); } };
    assert.deepEqual(await activateInvincibility(powerupInput(), store), {
      ok: false, reason: 'PERSISTENCE_ERROR',
    });
  });
});
