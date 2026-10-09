import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveAdminRevealPlan } from '../../src/game/adminReveal.ts';
import { EMERGENCY_LOCATION_FRESHNESS_MS } from '../../src/game/emergencyLocationProjection.ts';

const now = 1_800_000_000_000;

function player(id, team = 'A', status = 'ACTIVE') {
  return { id, team, status };
}

function location(id, overrides = {}) {
  return { id, latitude: 35.1, longitude: 139.1, updatedAt: now - 1_000, ...overrides };
}

function resolve(scope, roster, locations, durationMinutes = 5) {
  return resolveAdminRevealPlan({ scope, durationMinutes, roster, locations, now });
}

describe('Admin Reveal Core', () => {
  test('GLOBAL targets ordinary A/B participants and excludes Admin/unknown teams', () => {
    const result = resolve('GLOBAL', [
      player('a', 'A'), player('b', 'B'), player('admin', 'ADMIN'), player('unknown', 'X'),
    ], [location('a'), location('b')]);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.snapshots.map(snapshot => snapshot.playerId), ['a', 'b']);
    assert.equal(result.audience, 'AUTHENTICATED_PARTICIPANTS_AND_ADMIN');
  });

  test('TEAM_A and TEAM_B only target their respective participants', () => {
    const roster = [player('a', 'A'), player('b', 'B')];
    assert.deepEqual(resolve('TEAM_A', roster, [location('a'), location('b')]).snapshots.map(item => item.playerId), ['a']);
    assert.deepEqual(resolve('TEAM_B', roster, [location('a'), location('b')]).snapshots.map(item => item.playerId), ['b']);
  });

  test('Emergency and Retired players are skipped with a safety reason', () => {
    const result = resolve('GLOBAL', [
      player('emergency', 'A', 'EMERGENCY'), player('retired', 'B', 'RETIRED'), player('active'),
    ], [location('emergency'), location('retired'), location('active')]);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.skipped, [
      { playerId: 'emergency', reason: 'SAFETY_STATUS' },
      { playerId: 'retired', reason: 'SAFETY_STATUS' },
    ]);
    assert.deepEqual(result.snapshots.map(item => item.playerId), ['active']);
  });

  test('accepts fresh bounded coordinates and emits fixed timestamps and correct config field', () => {
    for (const [scope, field] of [
      ['GLOBAL', 'locationRevealUntil'], ['TEAM_A', 'teamARevealUntil'], ['TEAM_B', 'teamBRevealUntil'],
    ]) {
      const result = resolve(scope, [player('p', scope === 'TEAM_B' ? 'B' : 'A')], [location('p')], 1);
      assert.equal(result.allowed, true);
      assert.equal(result.configField, field);
      assert.equal(result.durationMilliseconds, 60_000);
      assert.equal(result.expiresAt, now + 60_000);
      assert.deepEqual(result.snapshots[0], {
        playerId: 'p', latitude: 35.1, longitude: 139.1,
        capturedAt: now, expiresAt: now + 60_000, revealScope: scope,
      });
    }
  });

  test('skips missing, mismatched, malformed, future, and stale locations without failing valid players', () => {
    const roster = ['missing', 'mismatch', 'bad-coord', 'bad-time', 'future', 'stale', 'valid']
      .map(id => player(id));
    const result = resolve('GLOBAL', roster, [
      location('mismatch-target'),
      location('bad-coord', { latitude: Infinity }),
      location('bad-time', { updatedAt: 'now' }),
      location('future', { updatedAt: now + 1 }),
      location('stale', { updatedAt: now - EMERGENCY_LOCATION_FRESHNESS_MS }),
      location('valid'),
    ]);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.skipped, [
      { playerId: 'missing', reason: 'MISSING_LOCATION' },
      { playerId: 'mismatch', reason: 'MISSING_LOCATION' },
      { playerId: 'bad-coord', reason: 'INVALID_COORDINATES' },
      { playerId: 'bad-time', reason: 'INVALID_TIMESTAMP' },
      { playerId: 'future', reason: 'FUTURE_TIMESTAMP' },
      { playerId: 'stale', reason: 'STALE_LOCATION' },
    ]);
    assert.deepEqual(result.snapshots.map(item => item.playerId), ['valid']);
  });

  test('enforces the exact freshness boundary as stale', () => {
    const result = resolve('GLOBAL', [player('p')], [
      location('p', { updatedAt: now - EMERGENCY_LOCATION_FRESHNESS_MS }),
    ]);
    assert.deepEqual(result, { allowed: false, reason: 'ZERO_VALID_LOCATIONS' });
  });

  test('accepts only integer durations from one through thirty minutes', () => {
    for (const duration of [1, 30]) {
      assert.equal(resolve('GLOBAL', [player('p')], [location('p')], duration).allowed, true);
    }
    for (const duration of [0, -1, 31, 1.5, NaN, Infinity, '5', undefined]) {
      assert.deepEqual(resolveAdminRevealPlan({
        scope: 'GLOBAL', durationMinutes: duration,
        roster: [player('p')], locations: [location('p')], now,
      }), {
        allowed: false, reason: 'INVALID_DURATION',
      });
    }
  });

  test('rejects invalid scope, malformed roster, and empty valid result', () => {
    assert.deepEqual(resolve('ALL', [player('p')], [location('p')]), {
      allowed: false, reason: 'INVALID_SCOPE',
    });
    assert.deepEqual(resolve('GLOBAL', [player('p', 'A', 'UNKNOWN')], [location('p')]), {
      allowed: false, reason: 'INVALID_ROSTER',
    });
    assert.deepEqual(resolve('GLOBAL', [player('p')], []), {
      allowed: false, reason: 'ZERO_VALID_LOCATIONS',
    });
  });

  test('does not mutate any input', () => {
    const input = {
      scope: 'TEAM_A', durationMinutes: 4,
      roster: [player('a', 'A'), player('b', 'B')],
      locations: [location('a'), location('b')], now,
    };
    const before = structuredClone(input);
    resolveAdminRevealPlan(input);
    assert.deepEqual(input, before);
  });
});
