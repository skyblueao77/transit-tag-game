import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateHaversineDistanceMeters,
  shouldThrottleLocationUpdate,
} from '../../src/game/locationThrottling.ts';

test('Location Throttling & Distance Calculations', async t => {
  const TOKYO_STATION = { latitude: 35.6812, longitude: 139.7671 };
  const YURAKUCHO_STATION = { latitude: 35.6750, longitude: 139.7633 };

  await t.test('calculateHaversineDistanceMeters calculates accurate distance', () => {
    assert.equal(calculateHaversineDistanceMeters(TOKYO_STATION, TOKYO_STATION), 0);

    const distanceTokyoToYurakucho = calculateHaversineDistanceMeters(TOKYO_STATION, YURAKUCHO_STATION);
    // Expected distance between Tokyo and Yurakucho is ~760-780 meters
    assert.ok(distanceTokyoToYurakucho > 700 && distanceTokyoToYurakucho < 850, `Distance was ${distanceTokyoToYurakucho}`);

    // Small displacement: 0.0001 deg latitude is approx 11.1 meters
    const smallMove = { latitude: TOKYO_STATION.latitude + 0.0001, longitude: TOKYO_STATION.longitude };
    const distSmall = calculateHaversineDistanceMeters(TOKYO_STATION, smallMove);
    assert.ok(distSmall > 10 && distSmall < 13, `Small distance was ${distSmall}`);

    // 0.0003 deg latitude is approx 33.3 meters (> 30m threshold)
    const thirtyMeterMove = { latitude: TOKYO_STATION.latitude + 0.0003, longitude: TOKYO_STATION.longitude };
    const distThirty = calculateHaversineDistanceMeters(TOKYO_STATION, thirtyMeterMove);
    assert.ok(distThirty > 30 && distThirty < 36, `30m distance was ${distThirty}`);
  });

  await t.test('shouldThrottleLocationUpdate enforces accuracy requirements', () => {
    const result = shouldThrottleLocationUpdate({
      currentCoords: TOKYO_STATION,
      currentAccuracy: 500, // exceeds default 400m
      currentTimeMs: 100_000,
      lastUploadedCoords: null,
      lastUploadedTimeMs: 0,
    });
    assert.equal(result.shouldUpload, false);
    assert.equal(result.reason, 'ACCURACY_POOR');
  });

  await t.test('shouldThrottleLocationUpdate allows initial upload when accuracy is good', () => {
    const result = shouldThrottleLocationUpdate({
      currentCoords: TOKYO_STATION,
      currentAccuracy: 15,
      currentTimeMs: 100_000,
      lastUploadedCoords: null,
      lastUploadedTimeMs: 0,
    });
    assert.equal(result.shouldUpload, true);
    assert.equal(result.reason, 'INITIAL');
  });

  await t.test('shouldThrottleLocationUpdate rejects updates within 60s rate limit (TOO_FREQUENT)', () => {
    const baseTime = 100_000;
    const result = shouldThrottleLocationUpdate({
      currentCoords: YURAKUCHO_STATION, // moved 770m
      currentAccuracy: 20,
      currentTimeMs: baseTime + 30_000, // only 30s elapsed (< 60s)
      lastUploadedCoords: TOKYO_STATION,
      lastUploadedTimeMs: baseTime,
    });
    assert.equal(result.shouldUpload, false);
    assert.equal(result.reason, 'TOO_FREQUENT');
  });

  await t.test('shouldThrottleLocationUpdate skips upload when stationary / small jitter (< 30m) after 60s', () => {
    const baseTime = 100_000;
    const jitterCoords = { latitude: TOKYO_STATION.latitude + 0.0001, longitude: TOKYO_STATION.longitude }; // ~11m move
    const result = shouldThrottleLocationUpdate({
      currentCoords: jitterCoords,
      currentAccuracy: 20,
      currentTimeMs: baseTime + 70_000, // 70s elapsed (> 60s)
      lastUploadedCoords: TOKYO_STATION,
      lastUploadedTimeMs: baseTime,
    });
    assert.equal(result.shouldUpload, false);
    assert.equal(result.reason, 'DISTANCE_BELOW_THRESHOLD');
    assert.ok(typeof result.distanceMeters === 'number' && result.distanceMeters < 30);
  });

  await t.test('shouldThrottleLocationUpdate permits upload when movement >= 30m and >= 60s elapsed', () => {
    const baseTime = 100_000;
    const movedCoords = { latitude: TOKYO_STATION.latitude + 0.0004, longitude: TOKYO_STATION.longitude }; // ~44m move
    const result = shouldThrottleLocationUpdate({
      currentCoords: movedCoords,
      currentAccuracy: 20,
      currentTimeMs: baseTime + 65_000, // 65s elapsed (> 60s)
      lastUploadedCoords: TOKYO_STATION,
      lastUploadedTimeMs: baseTime,
    });
    assert.equal(result.shouldUpload, true);
    assert.equal(result.reason, 'DISTANCE_EXCEEDED');
    assert.ok(typeof result.distanceMeters === 'number' && result.distanceMeters >= 30);
  });

  await t.test('shouldThrottleLocationUpdate forces heartbeat upload after 5 minutes even if stationary', () => {
    const baseTime = 100_000;
    const sameCoords = { ...TOKYO_STATION };
    const result = shouldThrottleLocationUpdate({
      currentCoords: sameCoords,
      currentAccuracy: 20,
      currentTimeMs: baseTime + 301_000, // 5m 1s elapsed (>= 300,000ms)
      lastUploadedCoords: TOKYO_STATION,
      lastUploadedTimeMs: baseTime,
    });
    assert.equal(result.shouldUpload, true);
    assert.equal(result.reason, 'MAX_QUIET_EXCEEDED');
  });
});
