import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveLocationVisibility } from '../../src/game/reveal.ts';

const now = 1_000_000;
const active = 'DAY1_ACTIVE';
const basePlayer = {
  id: 'runner-1',
  team: 'B',
  status: 'ACTIVE',
  lastLat: 35.1,
  lastLng: 139.1,
  exposedLat: 35.2,
  exposedLng: 139.2,
  locationExposedUntil: now + 10_000,
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
    assert.deepEqual(resolve({ locationExposedUntil: now }), { mode: 'HIDDEN' });
  });

  for (const status of ['EMERGENCY', 'RETIRED']) {
    test(`${status} opponent uses realtime coordinates`, () => {
      assert.deepEqual(resolve({ status, locationExposedUntil: undefined }), {
        mode: 'EMERGENCY_REALTIME', latitude: 35.1, longitude: 139.1,
      });
    });
  }

  test('team realtime reveal wins over snapshot modes', () => {
    assert.deepEqual(resolve({}, {
      teamBRevealUntil: now + 10_000,
      globalRevealUntil: now + 20_000,
    }), {
      mode: 'TEAM_REALTIME', latitude: 35.1, longitude: 139.1, expiresAt: now + 10_000,
    });
  });

  test('team realtime reveal expires exactly at its deadline', () => {
    assert.equal(resolve({}, { teamBRevealUntil: now }).mode, 'INDIVIDUAL_SNAPSHOT');
  });

  test('global reveal uses exposed snapshot coordinates, never private coordinates', () => {
    assert.deepEqual(resolve({ locationExposedUntil: undefined }, {
      globalRevealUntil: now + 10_000,
    }), {
      mode: 'GLOBAL_SNAPSHOT', latitude: 35.2, longitude: 139.2, expiresAt: now + 10_000,
    });
  });

  test('global snapshot wins over individual snapshot', () => {
    assert.equal(resolve({}, { globalRevealUntil: now + 10_000 }).mode, 'GLOBAL_SNAPSHOT');
  });

  test('global reveal expires exactly at its deadline', () => {
    assert.deepEqual(resolve({ locationExposedUntil: undefined }, {
      globalRevealUntil: now,
    }), { mode: 'HIDDEN' });
  });

  test('individual snapshot uses exposed coordinates and expires exactly at deadline', () => {
    assert.deepEqual(resolve(), {
      mode: 'INDIVIDUAL_SNAPSHOT', latitude: 35.2, longitude: 139.2, expiresAt: now + 10_000,
    });
    assert.deepEqual(resolve({ locationExposedUntil: now }), { mode: 'HIDDEN' });
  });

  test('public reveal is denied outside active public phases', () => {
    for (const phase of ['PRE_GAME', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER']) {
      assert.deepEqual(resolve({ locationExposedUntil: now + 10_000 }, {
        phase,
        globalRevealUntil: now + 10_000,
        teamBRevealUntil: now + 10_000,
      }), { mode: 'HIDDEN' });
    }
    assert.equal(resolve({}, { phase: 'DAY2_ACTIVE' }).mode, 'INDIVIDUAL_SNAPSHOT');
  });

  test('zero latitude and longitude are valid coordinates', () => {
    assert.deepEqual(resolve({ lastLat: 0, lastLng: 0, exposedLat: 0, exposedLng: 0 }), {
      mode: 'INDIVIDUAL_SNAPSHOT', latitude: 0, longitude: 0, expiresAt: now + 10_000,
    });
  });

  test('missing coordinates do not produce a visible result', () => {
    assert.deepEqual(resolve({ id: 'viewer-1', lastLat: undefined, lastLng: undefined }), { mode: 'HIDDEN' });
    assert.deepEqual(resolve({ exposedLat: undefined, exposedLng: undefined }), { mode: 'HIDDEN' });
  });

  test('unknown teams do not inherit team B reveal', () => {
    assert.equal(resolve({ team: 'ADMIN' }, { teamBRevealUntil: now + 10_000 }).mode, 'INDIVIDUAL_SNAPSHOT');
  });

  test('input objects are not mutated', () => {
    const player = { ...basePlayer };
    const input = { viewerId: 'viewer-1', player, phase: active, now };
    const before = structuredClone(input);
    resolveLocationVisibility(input);
    assert.deepEqual(input, before);
  });
});
