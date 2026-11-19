import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  hasActiveRevealWindow,
  PERIODIC_REVEAL_DEFAULT_DURATION_MINUTES,
  PERIODIC_REVEAL_DEFAULT_INTERVAL_MINUTES,
  PERIODIC_REVEAL_MAX_DURATION_MINUTES,
  PERIODIC_REVEAL_MAX_INTERVAL_MINUTES,
  PERIODIC_REVEAL_MIN_DURATION_MINUTES,
  PERIODIC_REVEAL_MIN_INTERVAL_MINUTES,
  resolveLocationVisibility,
  resolvePeriodicRevealWindow,
} from '../../src/game/reveal.ts';

const now = 1_000_000;
const active = 'DAY1_ACTIVE';
const basePlayer = {
  id: 'runner-1',
  team: 'B',
  status: 'ACTIVE',
  privateLatitude: 35.1,
  privateLongitude: 139.1,
  exposedLocation: { latitude: 35.2, longitude: 139.2, expiresAt: now + 10_000 },
};

function resolve(overrides = {}, context = {}) {
  return resolveLocationVisibility({
    viewerId: 'viewer-1',
    player: { ...basePlayer, ...overrides },
    phase: active,
    now,
    ...context,
  });
}

describe('location visibility rules', () => {
  test('self uses private coordinates', () => {
    assert.deepEqual(resolve({ id: 'viewer-1' }), {
      mode: 'SELF_PRIVATE', latitude: 35.1, longitude: 139.1,
    });
  });

  test('self wins over every public reveal mode', () => {
    assert.equal(resolve({ id: 'viewer-1' }, {
      globalRevealUntil: now + 1_000,
      teamBRevealUntil: now + 2_000,
    }).mode, 'SELF_PRIVATE');
  });

  test('normal opponent without an active reveal is hidden', () => {
    assert.deepEqual(resolve({ exposedLocation: { latitude: 35.2, longitude: 139.2, expiresAt: now } }), { mode: 'HIDDEN' });
  });

  for (const status of ['EMERGENCY', 'RETIRED']) {
    test(`${status} coordinates are not projected to participants`, () => {
      assert.deepEqual(resolve({ status }), { mode: 'HIDDEN' });
      assert.deepEqual(resolve({
        status,
        privateLatitude: undefined,
        privateLongitude: undefined,
        exposedLocation: { latitude: 35.2, longitude: 139.2, expiresAt: now + 10_000 },
      }), { mode: 'HIDDEN' });
    });
  }

  test('team reveal uses only its scoped snapshot rather than private realtime coordinates', () => {
    assert.deepEqual(resolve({
      exposedLocation: { latitude: 35.2, longitude: 139.2, expiresAt: now + 10_000, revealScope: 'TEAM_B' },
    }, {
      teamBRevealUntil: now + 10_000,
      globalRevealUntil: now + 20_000,
    }), {
      mode: 'TEAM_SNAPSHOT', latitude: 35.2, longitude: 139.2, expiresAt: now + 10_000,
    });
  });

  test('team reveal expires at its deadline and cannot expose a different scope snapshot', () => {
    assert.equal(resolve({
      exposedLocation: { ...basePlayer.exposedLocation, revealScope: 'TEAM_B' },
    }, { teamBRevealUntil: now }).mode, 'HIDDEN');
    assert.equal(resolve({
      exposedLocation: { ...basePlayer.exposedLocation, revealScope: 'TEAM_A' },
    }, { teamBRevealUntil: now + 10_000 }).mode, 'HIDDEN');
  });

  test('global reveal uses a GLOBAL exposed snapshot, never private coordinates', () => {
    assert.deepEqual(resolve({
      exposedLocation: { ...basePlayer.exposedLocation, revealScope: 'GLOBAL' },
    }, {
      globalRevealUntil: now + 20_000,
    }), {
      mode: 'GLOBAL_SNAPSHOT', latitude: 35.2, longitude: 139.2, expiresAt: now + 10_000,
    });
  });

  test('global snapshot wins over individual snapshot', () => {
    assert.equal(resolve({
      exposedLocation: { ...basePlayer.exposedLocation, revealScope: 'GLOBAL' },
    }, { globalRevealUntil: now + 10_000 }).mode, 'GLOBAL_SNAPSHOT');
  });

  test('global reveal expiry is enforced by both deadline and snapshot expiry', () => {
    assert.deepEqual(resolve({
      exposedLocation: { latitude: 35.2, longitude: 139.2, expiresAt: now + 10_000, revealScope: 'GLOBAL' },
    }, { globalRevealUntil: now }), { mode: 'HIDDEN' });
    assert.deepEqual(resolve({
      exposedLocation: { latitude: 35.2, longitude: 139.2, expiresAt: now, revealScope: 'GLOBAL' },
    }, { globalRevealUntil: now + 10_000 }), { mode: 'HIDDEN' });
  });

  test('individual snapshot uses exposed coordinates and expires exactly at deadline', () => {
    assert.deepEqual(resolve(), {
      mode: 'INDIVIDUAL_SNAPSHOT', latitude: 35.2, longitude: 139.2, expiresAt: now + 10_000,
    });
    assert.deepEqual(resolve({ exposedLocation: { latitude: 35.2, longitude: 139.2, expiresAt: now } }), { mode: 'HIDDEN' });
  });

  test('public reveal is denied outside active public phases', () => {
    for (const phase of ['PRE_GAME', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER']) {
      assert.deepEqual(resolve({ exposedLocation: { ...basePlayer.exposedLocation, revealScope: 'GLOBAL' } }, {
        phase,
        globalRevealUntil: now + 10_000,
        teamBRevealUntil: now + 10_000,
      }), { mode: 'HIDDEN' });
    }
    assert.equal(resolve({}, { phase: 'DAY2_ACTIVE' }).mode, 'INDIVIDUAL_SNAPSHOT');
  });

  test('zero latitude and longitude are valid coordinates', () => {
    assert.deepEqual(resolve({ privateLatitude: 0, privateLongitude: 0, exposedLocation: { latitude: 0, longitude: 0, expiresAt: now + 10_000 } }), {
      mode: 'INDIVIDUAL_SNAPSHOT', latitude: 0, longitude: 0, expiresAt: now + 10_000,
    });
  });

  test('missing coordinates do not produce a visible result', () => {
    assert.deepEqual(resolve({ id: 'viewer-1', privateLatitude: undefined, privateLongitude: undefined }), { mode: 'HIDDEN' });
    assert.deepEqual(resolve({ exposedLocation: undefined }), { mode: 'HIDDEN' });
  });

  test('unknown teams are hidden even with an active GLOBAL snapshot and deadline', () => {
    assert.deepEqual(resolve({
      team: 'ADMIN',
      exposedLocation: { ...basePlayer.exposedLocation, revealScope: 'GLOBAL' },
    }, { globalRevealUntil: now + 10_000 }), { mode: 'HIDDEN' });
    assert.deepEqual(resolve({
      team: 'unknown',
      exposedLocation: { ...basePlayer.exposedLocation, revealScope: 'INDIVIDUAL' },
    }), { mode: 'HIDDEN' });
  });

  test('penalty reveal exposes player location with PENALTY_SNAPSHOT mode', () => {
    assert.deepEqual(resolve({
      penaltyRevealUntil: now + 50_000,
      exposedLocation: { latitude: 35.3, longitude: 139.3, expiresAt: now + 60_000, revealScope: 'PENALTY' },
    }), {
      mode: 'PENALTY_SNAPSHOT',
      latitude: 35.3,
      longitude: 139.3,
      expiresAt: now + 50_000,
    });

    assert.equal(resolve({
      penaltyRevealUntil: now,
      exposedLocation: { latitude: 35.3, longitude: 139.3, expiresAt: now + 60_000, revealScope: 'PENALTY' },
    }).mode, 'HIDDEN');
  });

  test('resolvePeriodicRevealWindow handles pre-first-window, inside window, between cycles, clamping, and paused phases', () => {
    const startTime = 1_700_000_000_000;
    const intervalMs = 30 * 60_000;
    const durationMs = 5 * 60_000;

    // Pre-first window
    assert.deepEqual(resolvePeriodicRevealWindow({
      phase: 'DAY1_ACTIVE',
      now: startTime + 10 * 60_000,
      startTime,
      intervalMinutes: 30,
      durationMinutes: 5,
    }), {
      isActive: false,
      nextWindowStart: startTime + intervalMs,
    });

    // Inside cycle 1 window
    assert.deepEqual(resolvePeriodicRevealWindow({
      phase: 'DAY1_ACTIVE',
      now: startTime + intervalMs + 2 * 60_000,
      startTime,
      intervalMinutes: 30,
      durationMinutes: 5,
    }), {
      isActive: true,
      activeUntil: startTime + intervalMs + durationMs,
      nextWindowStart: startTime + 2 * intervalMs,
    });

    // Between cycle 1 end and cycle 2 start
    assert.deepEqual(resolvePeriodicRevealWindow({
      phase: 'DAY2_ACTIVE',
      now: startTime + intervalMs + durationMs,
      startTime,
      intervalMinutes: 30,
      durationMinutes: 5,
    }), {
      isActive: false,
      nextWindowStart: startTime + 2 * intervalMs,
    });

    // Parameter clamping & default fallback
    const clamped = resolvePeriodicRevealWindow({
      phase: 'DAY1_ACTIVE',
      now: startTime + PERIODIC_REVEAL_MIN_INTERVAL_MINUTES * 60_000 + 30_000,
      startTime,
      intervalMinutes: 1,
      durationMinutes: 999,
    });
    assert.equal(clamped.isActive, true);
    assert.equal(
      clamped.activeUntil,
      startTime + PERIODIC_REVEAL_MIN_INTERVAL_MINUTES * 60_000 + Math.min(PERIODIC_REVEAL_MAX_DURATION_MINUTES, PERIODIC_REVEAL_MIN_INTERVAL_MINUTES) * 60_000,
    );

    const defaults = resolvePeriodicRevealWindow({
      phase: 'DAY1_ACTIVE',
      now: startTime + PERIODIC_REVEAL_DEFAULT_INTERVAL_MINUTES * 60_000 + 10_000,
      startTime,
    });
    assert.equal(defaults.isActive, true);
    assert.equal(
      defaults.activeUntil,
      startTime + PERIODIC_REVEAL_DEFAULT_INTERVAL_MINUTES * 60_000 + PERIODIC_REVEAL_DEFAULT_DURATION_MINUTES * 60_000,
    );

    // Max interval clamping
    const maxClamped = resolvePeriodicRevealWindow({
      phase: 'DAY1_ACTIVE',
      now: startTime + PERIODIC_REVEAL_MAX_INTERVAL_MINUTES * 60_000 + 1000,
      startTime,
      intervalMinutes: 999,
      durationMinutes: 0,
    });
    assert.equal(maxClamped.isActive, true);
    assert.equal(
      maxClamped.activeUntil,
      startTime + PERIODIC_REVEAL_MAX_INTERVAL_MINUTES * 60_000 + PERIODIC_REVEAL_MIN_DURATION_MINUTES * 60_000,
    );

    // Paused / non-revealable phase
    assert.deepEqual(resolvePeriodicRevealWindow({
      phase: 'DAY1_PAUSED',
      now: startTime + intervalMs + 60_000,
      startTime,
      intervalMinutes: 30,
      durationMinutes: 5,
    }), { isActive: false });
  });

  test('resolveLocationVisibility exposes GLOBAL snapshot during periodic reveal window and hasActiveRevealWindow reflects active sources', () => {
    const epochNow = 1_700_000_000_000;
    const startTime = epochNow - 31 * 60_000;
    const vis = resolve({
      exposedLocation: { latitude: 35.2, longitude: 139.2, expiresAt: startTime + 35 * 60_000, revealScope: 'GLOBAL' },
    }, {
      now: epochNow,
      startTime,
      periodicRevealIntervalMinutes: 30,
      periodicRevealDurationMinutes: 5,
    });
    assert.deepEqual(vis, {
      mode: 'GLOBAL_SNAPSHOT',
      latitude: 35.2,
      longitude: 139.2,
      expiresAt: startTime + 35 * 60_000,
    });

    assert.equal(hasActiveRevealWindow({
      phase: 'DAY1_ACTIVE',
      startTime,
      periodicRevealIntervalMinutes: 30,
      periodicRevealDurationMinutes: 5,
    }, epochNow), true);

    assert.equal(hasActiveRevealWindow({
      phase: 'DAY1_ACTIVE',
      startTime: epochNow - 10 * 60_000,
      periodicRevealIntervalMinutes: 30,
      periodicRevealDurationMinutes: 5,
      players: [{ team: 'A', status: 'ACTIVE', penaltyRevealUntil: epochNow - 1000 }],
    }, epochNow), false);

    assert.equal(hasActiveRevealWindow({
      phase: 'DAY1_ACTIVE',
      players: [{ team: 'A', status: 'ACTIVE', penaltyRevealUntil: epochNow + 10_000 }],
    }, epochNow), true);
  });

  test('input objects are not mutated', () => {
    const player = { ...basePlayer };
    const input = { viewerId: 'viewer-1', player, phase: active, now };
    const before = structuredClone(input);
    resolveLocationVisibility(input);
    assert.deepEqual(input, before);
  });
});
