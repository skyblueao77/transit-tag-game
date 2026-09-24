import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  activateInvincibility,
  capturePlayer,
  completeMission,
} from '../src/application/index.ts';
import { INVINCIBILITY_DURATION_MS } from '../src/game/time.ts';

function missionStore() {
  const calls = [];
  return {
    calls,
    applyMissionCompletion: async input => calls.push(structuredClone(input)),
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

const missionInput = overrides => ({
  mission: { id: 'mission-1', points: 25 },
  isFinalMission: false,
  phase: 'DAY1_ACTIVE',
  randomValue: 0.5,
  playerId: 'runner-1',
  team: 'B',
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
  test('completes a normal mission and persists the score deltas', async () => {
    const store = missionStore();
    const result = await completeMission(missionInput({ randomValue: 0.5 }), store);

    assert.equal(result.ok, true);
    assert.deepEqual(result.reward, {
      missionId: 'mission-1', points: 25, isFinalMission: false,
    });
    assert.deepEqual(result.score, {
      teamScoreDelta: 25,
      playerScoreDelta: 25,
      invincibleCardDelta: 0,
      luckyReward: false,
    });
    assert.deepEqual(store.calls, [{
      playerId: 'runner-1', team: 'B', teamScoreDelta: 25,
      playerScoreDelta: 25, invincibleCardDelta: 0,
    }]);
  });

  test('completes a final mission in the final phase', async () => {
    const store = missionStore();
    const result = await completeMission(missionInput({
      mission: { id: 'final-1', points: 100 },
      isFinalMission: true,
      phase: 'FINAL_MISSION',
    }), store);

    assert.equal(result.ok, true);
    assert.equal(result.reward.isFinalMission, true);
    assert.equal(result.score.teamScoreDelta, 100);
    assert.equal(store.calls.length, 1);
  });

  test('rejects an invalid phase without persistence', async () => {
    const store = missionStore();
    assert.deepEqual(await completeMission(missionInput({ phase: 'DAY1_PAUSED' }), store), {
      ok: false, reason: 'MISSION_NOT_ALLOWED',
    });
    assert.equal(store.calls.length, 0);
  });

  test('awards the Lucky card below 0.2 but not at the 0.2 boundary', async () => {
    const luckyStore = missionStore();
    const lucky = await completeMission(missionInput({ randomValue: 0.199999 }), luckyStore);
    assert.equal(lucky.ok, true);
    assert.equal(lucky.score.invincibleCardDelta, 1);
    assert.equal(lucky.score.luckyReward, true);
    assert.equal(luckyStore.calls[0].invincibleCardDelta, 1);

    const boundaryStore = missionStore();
    const boundary = await completeMission(missionInput({ randomValue: 0.2 }), boundaryStore);
    assert.equal(boundary.ok, true);
    assert.equal(boundary.score.invincibleCardDelta, 0);
    assert.equal(boundary.score.luckyReward, false);
    assert.equal(boundaryStore.calls[0].invincibleCardDelta, 0);
  });

  test('does not mutate mission input', async () => {
    const input = missionInput({ mission: { id: 'mission-1', points: 25 } });
    const before = structuredClone(input);
    await completeMission(input, missionStore());
    assert.deepEqual(input, before);
  });

  test('returns persistence errors separately', async () => {
    const store = { applyMissionCompletion: async () => { throw new Error('offline'); } };
    assert.deepEqual(await completeMission(missionInput(), store), {
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
