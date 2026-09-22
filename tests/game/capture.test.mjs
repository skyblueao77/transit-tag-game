import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CAPTURE_REWARD_POINTS,
  resolveCapture,
} from '../../src/game/capture.ts';
import { CAPTURE_WAIT_DURATION_MS } from '../../src/game/time.ts';

const now = 1_000_000;
const roles = { teamARole: 'ONI', teamBRole: 'RUNNER' };

function player(id, team, status = 'ACTIVE', extra = {}) {
  return { id, team, status, invincibleCards: 0, ...extra };
}

function validInput(overrides = {}) {
  return {
    captorId: 'oni-1',
    targetId: 'runner-1',
    players: [player('oni-1', 'A'), player('runner-1', 'B')],
    teamRoles: roles,
    phase: 'DAY1_ACTIVE',
    now,
    ...overrides,
  };
}

describe('capture validation', () => {
  test('valid ONI captures an active RUNNER', () => {
    const result = resolveCapture(validInput());
    assert.equal(result.allowed, true);
  });

  test('phase policy is respected', () => {
    for (const phase of ['PRE_GAME', 'DAY1_PAUSED', 'GAME_OVER']) {
      assert.deepEqual(resolveCapture(validInput({ phase })), { allowed: false, reason: 'PHASE' });
    }
    for (const phase of ['DAY1_ACTIVE', 'DAY2_ACTIVE', 'FINAL_MISSION']) {
      assert.equal(resolveCapture(validInput({ phase })).allowed, true);
    }
  });

  test('unknown players are rejected', () => {
    assert.deepEqual(resolveCapture(validInput({ captorId: 'missing' })), {
      allowed: false,
      reason: 'CAPTOR_NOT_FOUND',
    });
    assert.deepEqual(resolveCapture(validInput({ targetId: 'missing' })), {
      allowed: false,
      reason: 'TARGET_NOT_FOUND',
    });
  });

  test('same player and same team are rejected', () => {
    assert.deepEqual(resolveCapture(validInput({ targetId: 'oni-1' })), {
      allowed: false,
      reason: 'SAME_PLAYER',
    });
    assert.deepEqual(resolveCapture(validInput({
      targetId: 'runner-1',
      players: [player('oni-1', 'A'), player('runner-1', 'A')],
    })), { allowed: false, reason: 'SAME_TEAM' });
  });

  test('roles and statuses are validated', () => {
    assert.deepEqual(resolveCapture(validInput({
      teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
    })), { allowed: false, reason: 'CAPTOR_ROLE' });
    assert.deepEqual(resolveCapture(validInput({
      teamRoles: { teamARole: 'ONI', teamBRole: 'ONI' },
    })), { allowed: false, reason: 'TARGET_ROLE' });
    assert.deepEqual(resolveCapture(validInput({
      players: [player('oni-1', 'A', 'WAITING'), player('runner-1', 'B')],
    })), { allowed: false, reason: 'CAPTOR_STATUS' });

    for (const status of ['WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED']) {
      assert.deepEqual(resolveCapture(validInput({
        players: [player('oni-1', 'A'), player('runner-1', 'B', status)],
      })), { allowed: false, reason: 'TARGET_STATUS' });
    }
  });

  test('active invincibility rejects capture but the exact boundary allows it', () => {
    assert.deepEqual(resolveCapture(validInput({
      players: [player('oni-1', 'A'), player('runner-1', 'B', 'ACTIVE', { invincibleUntil: now + 1 })],
    })), { allowed: false, reason: 'TARGET_INVINCIBLE' });
    assert.equal(resolveCapture(validInput({
      players: [player('oni-1', 'A'), player('runner-1', 'B', 'ACTIVE', { invincibleUntil: now })],
    })).allowed, true);
  });
});

describe('capture result', () => {
  test('returns reward, role swap, and next reveal deadline', () => {
    const result = resolveCapture(validInput({
      players: [
        player('oni-1', 'A', 'ACTIVE', { invincibleCards: 2 }),
        player('oni-2', 'A', 'ACTIVE', { invincibleCards: 1 }),
        player('runner-1', 'B', 'ACTIVE', { invincibleCards: 0 }),
      ],
    }));
    assert.equal(result.allowed, true);
    assert.deepEqual(result.reward, { team: 'A', scoreDelta: CAPTURE_REWARD_POINTS });
    assert.deepEqual(result.teamRoles, { teamARole: 'RUNNER', teamBRole: 'ONI' });
    assert.equal(result.nextRevealTime, now + CAPTURE_WAIT_DURATION_MS);
    assert.equal(result.waitingDuration, CAPTURE_WAIT_DURATION_MS);
  });

  test('former RUNNER team waits and resets invincibility', () => {
    const result = resolveCapture(validInput({
      players: [player('oni-1', 'A'), player('runner-1', 'B')],
    }));
    assert.equal(result.allowed, true);
    assert.deepEqual(result.playerChanges.find(change => change.playerId === 'runner-1'), {
      playerId: 'runner-1',
      status: 'WAITING',
      waitingUntil: now + CAPTURE_WAIT_DURATION_MS,
      invincibleUntil: 0,
      invincibleCardsDelta: 0,
    });
  });

  test('former ONI team becomes ACTIVE and receives one card', () => {
    const result = resolveCapture(validInput({
      players: [player('oni-1', 'A', 'ACTIVE', { invincibleCards: 2 }), player('runner-1', 'B')],
    }));
    assert.equal(result.allowed, true);
    assert.deepEqual(result.playerChanges.find(change => change.playerId === 'oni-1'), {
      playerId: 'oni-1',
      status: 'ACTIVE',
      waitingUntil: 0,
      invincibleCardsDelta: 1,
    });
  });

  test('excludes non-A/B players from player changes', () => {
    const admin = player('admin-1', 'ADMIN', 'ACTIVE', { invincibleCards: 7 });
    const result = resolveCapture(validInput({
      players: [player('oni-1', 'A'), player('runner-1', 'B'), admin],
    }));

    assert.equal(result.allowed, true);
    assert.equal(result.playerChanges.some(change => change.playerId === admin.id), false);
    assert.deepEqual(result.playerChanges, [
      {
        playerId: 'oni-1',
        status: 'ACTIVE',
        waitingUntil: 0,
        invincibleCardsDelta: 1,
      },
      {
        playerId: 'runner-1',
        status: 'WAITING',
        waitingUntil: now + CAPTURE_WAIT_DURATION_MS,
        invincibleUntil: 0,
        invincibleCardsDelta: 0,
      },
    ]);
  });

  test('does not mutate the input players', () => {
    const input = validInput();
    const before = structuredClone(input.players);
    resolveCapture(input);
    assert.deepEqual(input.players, before);
  });
});
