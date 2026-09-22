import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  gameTimeAt,
  isActiveUntil,
  isExpired,
  remainingSeconds,
  INVINCIBILITY_DURATION_MS,
} from '../../src/game/time.ts';
import { activateInvincibility } from '../../src/game/powerups.ts';
import {
  isWaitingActive,
  isWaitingExpired,
  remainingWaitingSeconds,
} from '../../src/game/waiting.ts';

const now = 1_000_000;
const activePhase = 'DAY1_ACTIVE';
const baseInput = {
  role: 'RUNNER',
  invincibleCards: 1,
  phase: activePhase,
  now,
};

describe('deadline helpers', () => {
  test('remaining time is positive for a future deadline', () => {
    assert.equal(remainingSeconds(now + 5_000, now), 5);
  });

  test('remaining time is zero at and after the deadline', () => {
    assert.equal(remainingSeconds(now, now), 0);
    assert.equal(remainingSeconds(now - 1, now), 0);
  });

  test('expiration boundary is deterministic', () => {
    assert.equal(isActiveUntil(now + 1, now), true);
    assert.equal(isExpired(now + 1, now), false);
    assert.equal(isActiveUntil(now, now), false);
    assert.equal(isExpired(now, now), true);
    assert.equal(isExpired(now - 1, now), true);
  });
});

describe('pause-aware game clock', () => {
  test('game time follows wall time without a pause', () => {
    assert.equal(gameTimeAt({ accumulatedPauseDuration: 0 }, now + 5_000), now + 5_000);
  });

  test('accumulated pause duration is removed from game time', () => {
    assert.equal(
      gameTimeAt({ accumulatedPauseDuration: 20_000 }, now + 60_000),
      now + 40_000,
    );
  });

  test('wall-clock movement after pause begins does not advance game time', () => {
    assert.equal(
      gameTimeAt({ pausedAt: now + 10_000, accumulatedPauseDuration: 0 }, now + 40_000),
      now + 10_000,
    );
  });
});

describe('invincibility activation', () => {
  test('runner with a card can activate in an active phase', () => {
    const result = activateInvincibility(baseInput);
    assert.equal(result.allowed, true);
    assert.equal(result.cardDelta, -1);
    assert.equal(result.duration, INVINCIBILITY_DURATION_MS);
    assert.equal(result.invincibleUntil, now + 30 * 60 * 1000);
  });

  test('activation is denied without cards, for oni, and in denied phases', () => {
    assert.equal(activateInvincibility({ ...baseInput, invincibleCards: 0 }).allowed, false);
    assert.equal(activateInvincibility({ ...baseInput, role: 'ONI' }).allowed, false);
    for (const phase of ['PRE_GAME', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_PAUSED', 'GAME_OVER']) {
      assert.equal(activateInvincibility({ ...baseInput, phase }).allowed, false);
    }
  });

  test('activation is denied while an existing effect is active', () => {
    assert.equal(
      activateInvincibility({ ...baseInput, invincibleUntil: now + 1 }).allowed,
      false,
    );
    assert.equal(
      activateInvincibility({ ...baseInput, invincibleUntil: now }).allowed,
      true,
    );
  });
});

describe('waiting deadlines', () => {
  test('future waiting deadline is active and has remaining time', () => {
    assert.equal(isWaitingActive('WAITING', now + 5_000, now), true);
    assert.equal(remainingWaitingSeconds(now + 5_000, now), 5);
  });

  test('waiting expires at the exact deadline and in the past', () => {
    assert.equal(isWaitingActive('WAITING', now, now), false);
    assert.equal(isWaitingExpired(now, now), true);
    assert.equal(isWaitingExpired(now - 1, now), true);
  });

  test('waiting requires the WAITING status', () => {
    assert.equal(isWaitingActive('ACTIVE', now + 5_000, now), false);
  });
});
