import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createEmergencyLocationHeartbeatController,
  EMERGENCY_LOCATION_HEARTBEAT_INTERVAL_MS,
  updateEmergencyLocationOnce,
} from '../src/infrastructure/emergencyLocationHeartbeat.ts';

const fixedPosition = {
  coords: { latitude: 35.6812, longitude: 139.7671, accuracy: 12 },
};

function fixture({ status = 'EMERGENCY', authUserId = 'player-1', playerId = 'player-1', online = true } = {}) {
  const timers = [];
  const updates = [];
  const geolocationCalls = [];
  const failures = [];
  const scheduler = {
    setInterval(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) {
      timer.cleared = true;
    },
  };
  const geolocation = {
    getCurrentPosition(success, error, options) {
      geolocationCalls.push({ success, error, options });
      success(fixedPosition);
      return geolocationCalls.length;
    },
  };
  const input = {
    status,
    playerId,
    authUserId,
    geolocation,
    updatePrivateLocation: async update => {
      updates.push(update);
      return { ok: true };
    },
    isCurrentPlayer: () => authUserId === playerId,
    isOnline: () => online,
    scheduler,
    onFailure: reason => failures.push(reason),
  };
  return { input, timers, updates, geolocationCalls, failures };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

describe('Emergency private-location heartbeat', () => {
  test('writes unchanged coordinates on the 60-second heartbeat', async () => {
    const { input, timers, updates, geolocationCalls } = fixture();
    const controller = createEmergencyLocationHeartbeatController();
    controller.sync(input);
    await settle();

    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, EMERGENCY_LOCATION_HEARTBEAT_INTERVAL_MS);
    assert.equal(geolocationCalls.length, 1);
    timers[0].callback();
    await settle();

    assert.equal(geolocationCalls.length, 2);
    assert.deepEqual(updates, [
      { playerId: 'player-1', latitude: 35.6812, longitude: 139.7671 },
      { playerId: 'player-1', latitude: 35.6812, longitude: 139.7671 },
    ]);
    controller.stop();
  });

  test('does not start for ACTIVE, WAITING, or RETIRED', () => {
    for (const status of ['ACTIVE', 'WAITING', 'RETIRED']) {
      const { input, timers, geolocationCalls } = fixture({ status });
      const controller = createEmergencyLocationHeartbeatController();
      controller.sync(input);
      assert.equal(timers.length, 0, status);
      assert.equal(geolocationCalls.length, 0, status);
    }
  });

  test('stops when status changes away from Emergency', async () => {
    const { input, timers, geolocationCalls } = fixture();
    const controller = createEmergencyLocationHeartbeatController();
    controller.sync(input);
    await settle();
    controller.sync({ ...input, status: 'ACTIVE' });

    assert.equal(timers[0].cleared, true);
    timers[0].callback();
    assert.equal(geolocationCalls.length, 1);
    controller.stop();
  });

  test('status change prevents an in-flight geolocation callback from writing', async () => {
    const { input, updates } = fixture();
    let finishPosition;
    input.geolocation.getCurrentPosition = success => { finishPosition = success; };
    const controller = createEmergencyLocationHeartbeatController();
    controller.sync(input);
    controller.sync({ ...input, status: 'ACTIVE' });
    finishPosition(fixedPosition);
    await settle();

    assert.equal(updates.length, 0);
  });

  test('cleanup stops the timer and prevents later location reads', async () => {
    const { input, timers, geolocationCalls } = fixture();
    const controller = createEmergencyLocationHeartbeatController();
    controller.sync(input);
    await settle();
    controller.stop();

    assert.equal(timers[0].cleared, true);
    timers[0].callback();
    assert.equal(geolocationCalls.length, 1);
  });

  test('same Player and status updates do not create duplicate timers', async () => {
    const { input, timers, geolocationCalls } = fixture();
    const controller = createEmergencyLocationHeartbeatController();
    controller.sync(input);
    controller.sync({ ...input });
    await settle();

    assert.equal(timers.length, 1);
    assert.equal(geolocationCalls.length, 1);
    controller.stop();
  });

  test('stops and restarts on Auth identity change without writing for the old identity', async () => {
    const { input, timers, updates, geolocationCalls } = fixture();
    const controller = createEmergencyLocationHeartbeatController();
    controller.sync(input);
    await settle();
    controller.sync({ ...input, authUserId: 'player-2', playerId: 'player-2', isCurrentPlayer: () => true });
    await settle();

    assert.equal(timers.length, 2);
    assert.equal(timers[0].cleared, true);
    assert.deepEqual(updates.map(update => update.playerId), ['player-1', 'player-2']);
    assert.equal(geolocationCalls.length, 2);
    controller.stop();
  });

  test('does not write while offline and resumes on the next heartbeat', async () => {
    let online = false;
    const { input, timers, updates, geolocationCalls } = fixture();
    input.isOnline = () => online;
    const controller = createEmergencyLocationHeartbeatController();
    controller.sync(input);
    await settle();
    assert.equal(geolocationCalls.length, 0);

    online = true;
    timers[0].callback();
    await settle();
    assert.equal(geolocationCalls.length, 1);
    assert.equal(updates.length, 1);
    controller.stop();
  });

  test('a geolocation failure does not reject the one-shot location update', async () => {
    const { input, updates } = fixture();
    input.geolocation.getCurrentPosition = (_success, error) => error(new Error('GPS denied'));

    assert.equal(await updateEmergencyLocationOnce(input), false);
    assert.equal(updates.length, 0);
  });
});
