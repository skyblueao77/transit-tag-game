import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EMERGENCY_LOCATION_FRESHNESS_MS,
  resolveEmergencyLocationProjection,
} from '../../src/game/emergencyLocationProjection.ts';

const now = 1_800_000_000_000;
const fresh = {
  status: 'EMERGENCY',
  latitude: 35.1,
  longitude: 139.1,
  sourceLocationUpdatedAt: now - 30_000,
  now,
};

describe('Emergency location projection policy', () => {
  test('projects only Emergency locations and excludes Retired/gameplay statuses', () => {
    assert.equal(resolveEmergencyLocationProjection(fresh).kind, 'PROJECT');
    for (const status of ['RETIRED', 'ACTIVE', 'WAITING', 'CAPTURED']) {
      assert.deepEqual(resolveEmergencyLocationProjection({ ...fresh, status }), { kind: 'NOT_REQUIRED' });
    }
  });

  test('accepts valid coordinate boundaries and rejects invalid coordinates', () => {
    assert.equal(resolveEmergencyLocationProjection({ ...fresh, latitude: 90, longitude: -180 }).kind, 'PROJECT');
    for (const [latitude, longitude] of [[90.1, 0], [-90.1, 0], [0, 180.1], [0, -180.1], [NaN, 0], [0, Infinity]]) {
      assert.deepEqual(resolveEmergencyLocationProjection({ ...fresh, latitude, longitude }), {
        kind: 'INVALID_COORDINATES',
      });
    }
  });

  test('rejects invalid and future source timestamps', () => {
    for (const sourceLocationUpdatedAt of [undefined, NaN, -1, now + 1]) {
      assert.deepEqual(resolveEmergencyLocationProjection({ ...fresh, sourceLocationUpdatedAt }), {
        kind: 'INVALID_TIME',
      });
    }
  });

  test('uses source timestamp plus the fixed freshness window for expiry', () => {
    const result = resolveEmergencyLocationProjection(fresh);
    assert.deepEqual(result, {
      kind: 'PROJECT',
      expiresAt: fresh.sourceLocationUpdatedAt + EMERGENCY_LOCATION_FRESHNESS_MS,
    });
  });

  test('expires exactly at the freshness boundary', () => {
    const boundary = fresh.sourceLocationUpdatedAt + EMERGENCY_LOCATION_FRESHNESS_MS;
    assert.deepEqual(resolveEmergencyLocationProjection({ ...fresh, now: boundary }), {
      kind: 'STALE_LOCATION',
    });
    assert.deepEqual(resolveEmergencyLocationProjection({ ...fresh, now: boundary - 1 }).kind, 'PROJECT');
  });

  test('does not mutate input', () => {
    const input = structuredClone(fresh);
    const before = structuredClone(input);
    resolveEmergencyLocationProjection(input);
    assert.deepEqual(input, before);
  });
});
