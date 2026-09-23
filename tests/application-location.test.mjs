import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { exposeLocation, updatePrivateLocation } from '../src/application/index.ts';

function privateStore() {
  const calls = [];
  return {
    calls,
    save: async (playerId, location) => calls.push({ playerId, location }),
  };
}

function exposedStore() {
  const calls = [];
  return {
    calls,
    saveSnapshot: async (playerId, snapshot) => calls.push({ playerId, snapshot }),
  };
}

const validInput = { playerId: 'player-1', latitude: 35.1, longitude: 139.1 };

describe('updatePrivateLocation application use case', () => {
  test('persists valid coordinates for the supplied player', async () => {
    const store = privateStore();
    const result = await updatePrivateLocation(validInput, store);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(store.calls, [{
      playerId: 'player-1',
      location: { latitude: 35.1, longitude: 139.1 },
    }]);
  });

  test('accepts zero coordinates', async () => {
    const store = privateStore();
    const result = await updatePrivateLocation({ ...validInput, latitude: 0, longitude: 0 }, store);

    assert.equal(result.ok, true);
    assert.equal(store.calls.length, 1);
  });

  test('rejects out-of-range and non-finite coordinates without persistence', async () => {
    for (const coordinates of [
      { latitude: 91, longitude: 0 },
      { latitude: -91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: 0, longitude: -181 },
      { latitude: Number.NaN, longitude: 0 },
      { latitude: 0, longitude: Number.POSITIVE_INFINITY },
    ]) {
      const store = privateStore();
      const result = await updatePrivateLocation({ ...validInput, ...coordinates }, store);
      assert.deepEqual(result, { ok: false, reason: 'INVALID_COORDINATES' });
      assert.equal(store.calls.length, 0);
    }
  });

  test('converts persistence failures to a plain failure result', async () => {
    const store = { save: async () => { throw new Error('offline'); } };
    assert.deepEqual(await updatePrivateLocation(validInput, store), {
      ok: false,
      reason: 'PERSISTENCE_ERROR',
    });
  });
});

describe('exposeLocation application use case', () => {
  test('persists an individual snapshot during an allowed phase', async () => {
    const store = exposedStore();
    const privateLocation = { latitude: 35.1, longitude: 139.1 };
    const result = await exposeLocation({
      playerId: 'player-1',
      privateLocation,
      phase: 'DAY1_ACTIVE',
      now: 1_000_000,
      duration: 300_000,
    }, store);

    assert.deepEqual(result, {
      ok: true,
      snapshot: {
        latitude: 35.1,
        longitude: 139.1,
        capturedAt: 1_000_000,
        expiresAt: 1_300_000,
      },
    });
    assert.deepEqual(store.calls, [{
      playerId: 'player-1',
      snapshot: {
        latitude: 35.1,
        longitude: 139.1,
        capturedAt: 1_000_000,
        expiresAt: 1_300_000,
      },
    }]);
  });

  test('denied phase does not call persistence', async () => {
    const store = exposedStore();
    const result = await exposeLocation({
      playerId: 'player-1',
      privateLocation: { latitude: 1, longitude: 2 },
      phase: 'FINAL_MISSION',
      now: 1_000_000,
      duration: 300_000,
    }, store);

    assert.deepEqual(result, { ok: false, reason: 'REVEAL_NOT_ALLOWED' });
    assert.equal(store.calls.length, 0);
  });

  test('requires private coordinates and accepts zero coordinates', async () => {
    const missingStore = exposedStore();
    assert.deepEqual(await exposeLocation({
      playerId: 'player-1', privateLocation: null, phase: 'DAY2_ACTIVE', now: 1, duration: 1,
    }, missingStore), { ok: false, reason: 'PRIVATE_LOCATION_MISSING' });
    assert.equal(missingStore.calls.length, 0);

    const zeroStore = exposedStore();
    assert.equal((await exposeLocation({
      playerId: 'player-1', privateLocation: { latitude: 0, longitude: 0 },
      phase: 'DAY2_ACTIVE', now: 1, duration: 10,
    }, zeroStore)).ok, true);
    assert.deepEqual(zeroStore.calls[0].snapshot, {
      latitude: 0, longitude: 0, capturedAt: 1, expiresAt: 11,
    });
  });

  test('copies snapshot coordinates and does not mutate or link to private location', async () => {
    const store = exposedStore();
    const privateLocation = { latitude: 10, longitude: 20 };
    const result = await exposeLocation({
      playerId: 'player-1', privateLocation, phase: 'DAY1_ACTIVE', now: 100, duration: 50,
    }, store);

    privateLocation.latitude = 30;
    privateLocation.longitude = 40;
    assert.deepEqual(result.snapshot, {
      latitude: 10, longitude: 20, capturedAt: 100, expiresAt: 150,
    });
    assert.deepEqual(store.calls[0].snapshot, result.snapshot);
  });

  test('rejects invalid coordinates and persistence failures', async () => {
    const invalidStore = exposedStore();
    assert.deepEqual(await exposeLocation({
      playerId: 'player-1', privateLocation: { latitude: 91, longitude: 0 },
      phase: 'DAY1_ACTIVE', now: 1, duration: 10,
    }, invalidStore), { ok: false, reason: 'INVALID_COORDINATES' });
    assert.equal(invalidStore.calls.length, 0);

    const failingStore = { saveSnapshot: async () => { throw new Error('offline'); } };
    assert.deepEqual(await exposeLocation({
      playerId: 'player-1', privateLocation: { latitude: 1, longitude: 2 },
      phase: 'DAY1_ACTIVE', now: 1, duration: 10,
    }, failingStore), { ok: false, reason: 'PERSISTENCE_ERROR' });
  });
});
