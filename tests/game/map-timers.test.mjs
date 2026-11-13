import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeMapTimeLeft } from '../../src/game/mapTimers.ts';
import { ONI_INITIAL_LOCK_DURATION_MS } from '../../src/game/time.ts';

describe('computeMapTimeLeft', () => {
  const now = 1_700_000_000_000;

  test('computes oniLock synchronously for ONI within initial 30m window and 0 for RUNNER', () => {
    const baseInput = {
      currentUser: {
        team: 'A',
        status: 'ACTIVE',
      },
      gameConfig: {
        gameStatus: 'DAY1_ACTIVE',
        startTime: now - 10 * 60 * 1000,
      },
      now,
    };

    const oniResult = computeMapTimeLeft({ ...baseInput, currentRole: 'ONI' });
    assert.equal(oniResult.oniLock, Math.floor((ONI_INITIAL_LOCK_DURATION_MS - 10 * 60 * 1000) / 1000));

    const runnerResult = computeMapTimeLeft({ ...baseInput, currentRole: 'RUNNER' });
    assert.equal(runnerResult.oniLock, 0);
  });

  test('returns 0 shinkansenRemaining when not riding even if limit is 0 (unlimited)', () => {
    const result = computeMapTimeLeft({
      currentUser: {
        team: 'A',
        status: 'ACTIVE',
      },
      gameConfig: {
        gameStatus: 'DAY1_ACTIVE',
        shinkansenMaxMinutes: 0,
      },
      currentRole: 'RUNNER',
      now,
    });

    assert.equal(result.shinkansenRemaining, 0);
  });

  test('returns Infinity shinkansenRemaining while riding when limit is 0', () => {
    const result = computeMapTimeLeft({
      currentUser: {
        team: 'A',
        status: 'ACTIVE',
        shinkansenStartTime: now - 60_000,
      },
      gameConfig: {
        gameStatus: 'DAY1_ACTIVE',
        shinkansenMaxMinutes: 0,
      },
      currentRole: 'RUNNER',
      now,
    });

    assert.equal(result.shinkansenRemaining, Number.POSITIVE_INFINITY);
  });

  test('computes team reveal, force reveal, penalty, invincible, waiting, and final mission timers', () => {
    const result = computeMapTimeLeft({
      currentUser: {
        team: 'B',
        status: 'WAITING',
        waitingUntil: now + 120_000,
        invincibleUntil: now + 90_000,
        shinkansenStartTime: now - 30 * 60 * 1000,
        penaltyRevealUntil: now + 45_000,
      },
      gameConfig: {
        gameStatus: 'FINAL_MISSION',
        startTime: now - 40 * 60 * 1000,
        nextRevealTime: now + 300_000,
        isFinalMissionActive: true,
        finalMissionEndTime: now + 600_000,
        locationRevealUntil: now + 60_000,
        teamARevealUntil: now + 500_000,
        teamBRevealUntil: now + 180_000,
        shinkansenMaxMinutes: 150,
      },
      currentRole: 'ONI',
      now,
    });

    assert.equal(result.waiting, 120);
    assert.equal(result.invincible, 90);
    assert.equal(result.nextReveal, 300);
    assert.equal(result.final, 600);
    assert.equal(result.oniLock, 0);
    assert.equal(result.shinkansenRemaining, 120 * 60);
    assert.equal(result.forceReveal, 60);
    assert.equal(result.teamSearchRemaining, 180);
    assert.equal(result.penaltyRemaining, 45);
  });

  test('preserves previous countdowns during paused phase while still updating waiting and oniLock', () => {
    const previous = {
      waiting: 200,
      invincible: 150,
      nextReveal: 400,
      final: 0,
      oniLock: 50,
      shinkansenRemaining: 300,
      forceReveal: 30,
      teamSearchRemaining: 20,
      penaltyRemaining: 10,
    };

    const paused = computeMapTimeLeft(
      {
        currentUser: {
          team: 'A',
          status: 'WAITING',
          waitingUntil: now + 180_000,
        },
        gameConfig: {
          gameStatus: 'DAY1_PAUSED',
          startTime: now - (ONI_INITIAL_LOCK_DURATION_MS - 40_000),
        },
        currentRole: 'ONI',
        now,
      },
      previous,
    );

    assert.equal(paused.waiting, 180);
    assert.equal(paused.oniLock, 40);
    assert.equal(paused.nextReveal, 400);
    assert.equal(paused.invincible, 150);
  });
});
