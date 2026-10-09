import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveLocationVisibility } from '../../src/game/reveal.ts';

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

  test('input objects are not mutated', () => {
    const player = { ...basePlayer };
    const input = { viewerId: 'viewer-1', player, phase: active, now };
    const before = structuredClone(input);
    resolveLocationVisibility(input);
    assert.deepEqual(input, before);
  });
});
