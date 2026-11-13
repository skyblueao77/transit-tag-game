import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AUTO_EXPOSE_MAX_DURATION_MS, resolveAutoExposePlan } from '../../src/game/autoExpose.ts';

const NOW = 1_700_000_000_000;
const SESSION_ID = 'session-active-01';

function baseInput(overrides = {}) {
  return {
    isOnline: true,
    isAdmin: false,
    now: NOW,
    currentUser: {
      id: 'player-a1',
      team: 'A',
      status: 'ACTIVE',
      penaltyRevealUntil: 0,
    },
    gameConfig: {
      gameSessionId: SESSION_ID,
      gameStatus: 'DAY1_ACTIVE',
      locationRevealUntil: null,
      teamARevealUntil: null,
      teamBRevealUntil: null,
    },
    privateLocation: {
      gameSessionId: SESSION_ID,
      latitude: 35.6812,
      longitude: 139.7671,
    },
    existingExposedLocation: null,
    ...overrides,
  };
}

describe('Auto-expose projection planning', () => {
  test('returns null when offline, admin, safety-excluded, or non-revealable phase', () => {
    const withGlobal = {
      gameConfig: {
        gameSessionId: SESSION_ID,
        gameStatus: 'DAY1_ACTIVE',
        locationRevealUntil: NOW + 120_000,
      },
    };

    assert.equal(resolveAutoExposePlan(baseInput({ ...withGlobal, isOnline: false })), null);
    assert.equal(resolveAutoExposePlan(baseInput({ ...withGlobal, isAdmin: true })), null);
    assert.equal(resolveAutoExposePlan(baseInput({ ...withGlobal, currentUser: null })), null);
    assert.equal(
      resolveAutoExposePlan(baseInput({
        ...withGlobal,
        currentUser: { id: 'p1', team: 'A', status: 'EMERGENCY', penaltyRevealUntil: NOW + 60_000 },
      })),
      null,
    );
    assert.equal(
      resolveAutoExposePlan(baseInput({
        ...withGlobal,
        currentUser: { id: 'p1', team: 'A', status: 'RETIRED', penaltyRevealUntil: NOW + 60_000 },
      })),
      null,
    );
    assert.equal(
      resolveAutoExposePlan(baseInput({
        gameConfig: { gameSessionId: SESSION_ID, gameStatus: 'PRE_GAME', locationRevealUntil: NOW + 60_000 },
      })),
      null,
    );
    assert.equal(
      resolveAutoExposePlan(baseInput({
        ...withGlobal,
        privateLocation: { gameSessionId: 'stale-session', latitude: 35.6, longitude: 139.7 },
      })),
      null,
    );
  });

  test('prioritizes PENALTY > GLOBAL > TEAM_A / TEAM_B', () => {
    const penaltyPlan = resolveAutoExposePlan(baseInput({
      currentUser: {
        id: 'player-a1',
        team: 'A',
        status: 'ACTIVE',
        penaltyRevealUntil: NOW + 90_000,
      },
      gameConfig: {
        gameSessionId: SESSION_ID,
        gameStatus: 'DAY1_ACTIVE',
        locationRevealUntil: NOW + 180_000,
        teamARevealUntil: NOW + 240_000,
      },
    }));
    assert.deepEqual(penaltyPlan, {
      revealScope: 'PENALTY',
      duration: 90_000,
      targetUntil: NOW + 90_000,
    });

    const globalPlan = resolveAutoExposePlan(baseInput({
      gameConfig: {
        gameSessionId: SESSION_ID,
        gameStatus: 'DAY1_ACTIVE',
        locationRevealUntil: NOW + 180_000,
        teamARevealUntil: NOW + 240_000,
      },
    }));
    assert.deepEqual(globalPlan, {
      revealScope: 'GLOBAL',
      duration: 180_000,
      targetUntil: NOW + 180_000,
    });

    const teamAPlan = resolveAutoExposePlan(baseInput({
      gameConfig: {
        gameSessionId: SESSION_ID,
        gameStatus: 'DAY1_ACTIVE',
        teamARevealUntil: NOW + 240_000,
        teamBRevealUntil: NOW + 300_000,
      },
    }));
    assert.equal(teamAPlan?.revealScope, 'TEAM_A');

    const teamBPlan = resolveAutoExposePlan(baseInput({
      currentUser: { id: 'player-b1', team: 'B', status: 'ACTIVE' },
      gameConfig: {
        gameSessionId: SESSION_ID,
        gameStatus: 'DAY1_ACTIVE',
        teamARevealUntil: NOW + 240_000,
        teamBRevealUntil: NOW + 300_000,
      },
    }));
    assert.equal(teamBPlan?.revealScope, 'TEAM_B');
    assert.equal(teamBPlan?.duration, 300_000);
  });

  test('clamps duration to AUTO_EXPOSE_MAX_DURATION_MS', () => {
    const plan = resolveAutoExposePlan(baseInput({
      currentUser: {
        id: 'player-a1',
        team: 'A',
        status: 'ACTIVE',
        penaltyRevealUntil: NOW + 3 * 60 * 60 * 1000,
      },
    }));

    assert.equal(plan?.revealScope, 'PENALTY');
    assert.equal(plan?.duration, AUTO_EXPOSE_MAX_DURATION_MS);
  });

  test('skips redundant re-upload when snapshot scope and expiry match without movement', () => {
    const targetUntil = NOW + 120_000;
    const plan = resolveAutoExposePlan(baseInput({
      gameConfig: {
        gameSessionId: SESSION_ID,
        gameStatus: 'DAY1_ACTIVE',
        locationRevealUntil: targetUntil,
      },
      existingExposedLocation: {
        gameSessionId: SESSION_ID,
        revealScope: 'GLOBAL',
        expiresAt: targetUntil - 1000,
        latitude: 35.6812,
        longitude: 139.7671,
      },
    }));

    assert.equal(plan, null);
  });

  test('re-publishes PENALTY snapshot when player moves more than 0.0001 degrees', () => {
    const targetUntil = NOW + 600_000;
    const plan = resolveAutoExposePlan(baseInput({
      currentUser: {
        id: 'player-a1',
        team: 'A',
        status: 'ACTIVE',
        penaltyRevealUntil: targetUntil,
      },
      privateLocation: {
        gameSessionId: SESSION_ID,
        latitude: 35.6825,
        longitude: 139.7671,
      },
      existingExposedLocation: {
        gameSessionId: SESSION_ID,
        revealScope: 'PENALTY',
        expiresAt: targetUntil,
        latitude: 35.6812,
        longitude: 139.7671,
      },
    }));

    assert.deepEqual(plan, {
      revealScope: 'PENALTY',
      duration: 600_000,
      targetUntil,
    });
  });
});
