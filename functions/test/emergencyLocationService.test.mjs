import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { projectEmergencyLocationForPlayer } from '../lib/functions/src/emergencyLocation/emergencyLocationService.js';

const now = 1_800_000_000_000;

function fixture({
  player = { id: 'uid-a', name: 'Trusted Player', team: 'A', status: 'EMERGENCY' },
  location = { latitude: 35.1, longitude: 139.1, updatedAt: now - 30_000 },
  projection = null,
  playerId = 'uid-a',
  locationId = 'uid-a',
} = {}) {
  const state = { player, location, projection, playerId, locationId, writes: [], reads: [] };
  const store = {
    async runTransaction(work) {
      const pending = [];
      const result = await work({
        readPlayer: async uid => {
          state.reads.push(['player', uid]);
          return state.player ? { id: state.playerId, data: structuredClone(state.player) } : null;
        },
        readPrivateLocation: async uid => {
          state.reads.push(['location', uid]);
          return state.location ? { id: state.locationId, data: structuredClone(state.location) } : null;
        },
        readProjection: async uid => {
          state.reads.push(['projection', uid]);
          return state.projection ? { id: uid, data: structuredClone(state.projection) } : null;
        },
        writeProjection: (uid, data) => pending.push(['set', uid, structuredClone(data)]),
        deleteProjection: uid => pending.push(['delete', uid]),
      });
      for (const write of pending) {
        state.writes.push(write);
        if (write[0] === 'set') state.projection = write[2];
        else state.projection = null;
      }
      return result;
    },
  };
  return { state, store };
}

function runtime(timestamp = now) {
  let calls = 0;
  return { now: () => { calls += 1; return timestamp; }, calls: () => calls };
}

describe('Emergency location projection service', () => {
  test('creates a minimal projection from trusted Emergency player and fresh private location', async () => {
    const { state, store } = fixture();
    const clock = runtime();
    const result = await projectEmergencyLocationForPlayer('uid-a', store, clock);
    assert.deepEqual(result, { status: 'CREATED' });
    assert.equal(clock.calls(), 1);
    assert.deepEqual(state.writes, [['set', 'uid-a', {
      playerId: 'uid-a', latitude: 35.1, longitude: 139.1,
      projectedAt: now, sourceLocationUpdatedAt: now - 30_000,
      expiresAt: now - 30_000 + 120_000,
      safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY',
    }]]);
    assert.deepEqual(state.reads, [['player', 'uid-a'], ['location', 'uid-a'], ['projection', 'uid-a']]);
    assert.equal('name' in state.projection, false);
    assert.equal('reason' in state.projection, false);
  });

  test('refreshes an existing projection and keeps input state unchanged', async () => {
    const input = {
      player: { id: 'uid-a', name: 'Private name', team: 'B', status: 'EMERGENCY' },
      location: { latitude: 0, longitude: 0, updatedAt: now - 10 },
      projection: { latitude: -1 },
    };
    const before = structuredClone(input);
    const { state, store } = fixture(input);
    assert.deepEqual(await projectEmergencyLocationForPlayer('uid-a', store, runtime()), { status: 'REFRESHED' });
    assert.deepEqual(input, before);
    assert.equal(state.projection.latitude, 0);
  });

  test('does not project Retired or other non-Emergency states and deletes any old projection', async () => {
    for (const status of ['RETIRED', 'ACTIVE', 'WAITING', 'CAPTURED']) {
      const { state, store } = fixture({
        player: { id: 'uid-a', name: 'Player', team: 'A', status },
        projection: { playerId: 'uid-a' },
      });
      assert.deepEqual(await projectEmergencyLocationForPlayer('uid-a', store, runtime()), { status: 'NOT_REQUIRED' });
      assert.deepEqual(state.writes, [['delete', 'uid-a']]);
    }
  });

  test('missing Player/location and malformed identity/team/location yield no projection writes', async () => {
    for (const options of [
      { player: null },
      { location: null },
      { playerId: 'other' },
      { locationId: 'other' },
      { player: { id: 'uid-a', name: '', team: 'A', status: 'EMERGENCY' } },
      { player: { id: 'uid-a', name: 'Player', team: 'A', status: 'UNKNOWN' } },
      { player: { id: 'uid-a', name: 'Player', team: 'ADMIN', status: 'EMERGENCY' } },
      { location: { latitude: 91, longitude: 139, updatedAt: now - 1 } },
      { location: { latitude: 35, longitude: 139, updatedAt: 'now' } },
    ]) {
      const { state, store } = fixture(options);
      const result = await projectEmergencyLocationForPlayer('uid-a', store, runtime());
      assert.deepEqual(result, { status: 'UNAVAILABLE' });
      assert.deepEqual(state.writes, []);
    }
  });

  test('stale location removes the previous projection', async () => {
    const { state, store } = fixture({
      location: { latitude: 35, longitude: 139, updatedAt: now - 120_000 },
      projection: { playerId: 'uid-a' },
    });
    assert.deepEqual(await projectEmergencyLocationForPlayer('uid-a', store, runtime()), { status: 'STALE' });
    assert.deepEqual(state.writes, [['delete', 'uid-a']]);
  });

  test('transaction failure propagates to trusted caller', async () => {
    await assert.rejects(projectEmergencyLocationForPlayer('uid-a', {
      runTransaction: async () => { throw new Error('Firestore unavailable'); },
    }, runtime()), /Firestore unavailable/);
  });

  test('rejects invalid invocation time without touching storage', async () => {
    const { state, store } = fixture();
    assert.deepEqual(await projectEmergencyLocationForPlayer('uid-a', store, runtime(NaN)), { status: 'UNAVAILABLE' });
    assert.deepEqual(state.reads, []);
    assert.deepEqual(state.writes, []);
  });
});
