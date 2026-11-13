import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { AUTO_EXPOSE_MAX_DURATION_MS, resolveAutoExposePlan } from '../../src/game/autoExpose.ts';
import { resolveAdminRevealSchedule } from '../../src/game/adminReveal.ts';
import { resolveEmergencyLocationProjection } from '../../src/game/emergencyLocationProjection.ts';
import { shouldThrottleLocationUpdate } from '../../src/game/locationThrottling.ts';
import { resolveLocationVisibility } from '../../src/game/reveal.ts';
import { formatSegmentLabel, formatStationLabel } from '../../src/game/stationInference.ts';
import { createEmergencyLocationHeartbeatController } from '../../src/infrastructure/emergencyLocationHeartbeat.ts';
import {
  getServerNowMs,
  resetServerClockForTest,
  setServerTimeOffsetMsForTest,
} from '../../src/infrastructure/firebase/serverClock.ts';
import {
  FsTimestamp,
  RulePermissionError,
  SERVER_TIMESTAMP_SENTINEL,
  createActiveParticipantDb,
} from './helpers/rulesContractHarness.mjs';

const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const mapViewSource = readFileSync(new URL('../../views/MapView.tsx', import.meta.url), 'utf8');
const useAdminDashboardSource = readFileSync(new URL('../../views/admin/useAdminDashboard.ts', import.meta.url), 'utf8');

describe('Audit 06: Location Tracking, AutoExpose, Admin Reveal, Penalty & Safety/SOS Heartbeat', () => {
  test('[AUDIT-BUG] useMapGeolocation is mounted in App.tsx so GPS tracking continues on /mission tab', () => {
    const appHasGeo = appSource.includes('useMapGeolocation');
    const mapHasGeo = mapViewSource.includes('useMapGeolocation');
    assert.equal(mapHasGeo, false);
    assert.equal(
      appHasGeo,
      true,
      'Expected useMapGeolocation to be mounted in App.tsx rather than MapView.tsx',
    );
  });

  test('[AUDIT-BUG] clientSafetyActionGateway falsely produces UNAVAILABLE when server privateLocations.updatedAt is > client Date.now()', () => {
    // Reproduces gameplayGateways.ts lines 651-662:
    // Player updates privateLocation (`updatedAt: serverTimestamp()`), then immediately clicks SOS.
    // If server clock is 500ms ahead of device clock, `sourceLocationUpdatedAt` (server) > `now` (client Date.now()).
    const clientNow = 1_750_000_000_000;
    const serverUpdatedAtMs = clientNow + 500;
    const decision = resolveEmergencyLocationProjection({
      status: 'EMERGENCY',
      latitude: 35.6812,
      longitude: 139.7671,
      sourceLocationUpdatedAt: serverUpdatedAtMs,
      now: clientNow,
    });
    assert.equal(
      decision.kind,
      'PROJECT',
      `[AUDIT-BUG] resolveEmergencyLocationProjection rejects future sourceLocationUpdatedAt > now (${decision.kind}), causing SOS to skip projection with projectionStatus='UNAVAILABLE' whenever Firestore server clock is even 1ms ahead of device clock!`,
    );
  });

  test('[AUDIT-BUG] penalty reveal with serverClock + 58m AUTO_EXPOSE_MAX_DURATION_MS passes exposedLocations rule under +65s client skew', () => {
    const { db, sessionId } = createActiveParticipantDb();
    const clientNow = db.serverNowMs + 65_000;
    const penaltyUntil = db.serverNowMs + 120 * 60_000;

    db.seed('users/uA', {
      id: 'uA', name: 'A', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
      penaltyRevealUntil: penaltyUntil,
    });

    try {
      setServerTimeOffsetMsForTest(db.serverNowMs - clientNow);
      const syncedNow = getServerNowMs(clientNow);
      assert.equal(syncedNow, db.serverNowMs);
      assert.equal(AUTO_EXPOSE_MAX_DURATION_MS, 58 * 60_000);

      const plan = resolveAutoExposePlan({
        isOnline: true,
        isAdmin: false,
        now: syncedNow,
        currentUser: db.rawGet('users/uA'),
        gameConfig: { gameSessionId: sessionId, gameStatus: 'DAY1_ACTIVE' },
        privateLocation: { gameSessionId: sessionId, latitude: 35.68, longitude: 139.76 },
        existingExposedLocation: undefined,
      });
      assert.ok(plan);
      assert.equal(plan.revealScope, 'PENALTY');
      assert.equal(plan.duration, AUTO_EXPOSE_MAX_DURATION_MS);

      db.commitBatch([{
        type: 'set',
        path: 'exposedLocations/uA',
        data: {
          playerId: 'uA',
          gameSessionId: sessionId,
          latitude: 35.68,
          longitude: 139.76,
          capturedAt: FsTimestamp.fromMillis(syncedNow),
          expiresAt: FsTimestamp.fromMillis(syncedNow + plan.duration),
          revealScope: plan.revealScope,
        },
        merge: false,
      }], { uid: 'uA', signInProvider: 'password' });
      assert.equal(db.rawGet('exposedLocations/uA').revealScope, 'PENALTY');
    } finally {
      resetServerClockForTest();
    }
  });

  test('[AUDIT-BUG] Admin reveal clarifies async projection directive delivery without requiring admin read on privateLocations', () => {
    const schedule = resolveAdminRevealSchedule({
      scope: 'GLOBAL',
      durationMinutes: 10,
      roster: [
        { id: 'offline-player-1', team: 'A', status: 'ACTIVE' },
        { id: 'no-gps-player-2', team: 'B', status: 'ACTIVE' },
      ],
      now: 1_750_000_000_000,
    });
    assert.equal(schedule.allowed, true);
    assert.equal(schedule.targetPlayerIds.length, 2);
    assert.ok(
      useAdminDashboardSource.includes('順次位置共有'),
      'Expected admin reveal toast copy to clarify async client-driven projection delivery',
    );
  });

  test('exposedLocations snapshot replacement enforces monotonic PENALTY and scope priority', () => {
    const { db, sessionId } = createActiveParticipantDb({
      config: {
        locationRevealUntil: FsTimestamp.fromMillis(1_750_000_000_000 + 600_000),
      },
    });
    db.seed('users/uA', {
      id: 'uA', name: 'A', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
      penaltyRevealUntil: db.serverNowMs + 1_200_000,
    });
    const uAuth = { uid: 'uA', signInProvider: 'password' };

    db.commitBatch([{
      type: 'set',
      path: 'exposedLocations/uA',
      data: {
        playerId: 'uA', gameSessionId: sessionId, latitude: 35.6, longitude: 139.7,
        capturedAt: FsTimestamp.fromMillis(db.serverNowMs),
        expiresAt: FsTimestamp.fromMillis(db.serverNowMs + 300_000),
        revealScope: 'INDIVIDUAL',
      },
      merge: false,
    }], uAuth);

    db.commitBatch([{
      type: 'set',
      path: 'exposedLocations/uA',
      data: {
        playerId: 'uA', gameSessionId: sessionId, latitude: 35.61, longitude: 139.71,
        capturedAt: FsTimestamp.fromMillis(db.serverNowMs),
        expiresAt: FsTimestamp.fromMillis(db.serverNowMs + 1_200_000),
        revealScope: 'PENALTY',
      },
      merge: false,
    }], uAuth);

    assert.throws(() => {
      db.commitBatch([{
        type: 'set',
        path: 'exposedLocations/uA',
        data: {
          playerId: 'uA', gameSessionId: sessionId, latitude: 35.62, longitude: 139.72,
          capturedAt: FsTimestamp.fromMillis(db.serverNowMs),
          expiresAt: FsTimestamp.fromMillis(db.serverNowMs + 600_000),
          revealScope: 'GLOBAL',
        },
        merge: false,
      }], uAuth);
    }, RulePermissionError);
  });

  test('SOS EMERGENCY deletes exposedLocations, creates emergencyLocationProjections, and blocks EMERGENCY user from writing exposedLocations', () => {
    const { db, sessionId } = createActiveParticipantDb();
    db.seed('users/uA', {
      id: 'uA', name: 'A', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
    });
    db.seed('exposedLocations/uA', {
      playerId: 'uA', gameSessionId: sessionId, latitude: 35.6, longitude: 139.7,
      capturedAt: FsTimestamp.fromMillis(db.serverNowMs),
      expiresAt: FsTimestamp.fromMillis(db.serverNowMs + 300_000),
      revealScope: 'INDIVIDUAL',
    });
    const uAuth = { uid: 'uA', signInProvider: 'password' };

    db.commitBatch([
      { type: 'update', path: 'users/uA', data: { status: 'EMERGENCY', waitingUntil: 0, shinkansenStartTime: null, invincibleUntil: 0 } },
      { type: 'delete', path: 'exposedLocations/uA' },
      { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'sos1', timestamp: db.serverNowMs, message: 'SOS', type: 'EMERGENCY' }] } },
      {
        type: 'set',
        path: 'emergencyLocationProjections/uA',
        data: {
          playerId: 'uA', gameSessionId: sessionId, latitude: 35.6812, longitude: 139.7671,
          projectedAt: SERVER_TIMESTAMP_SENTINEL,
          sourceLocationUpdatedAt: FsTimestamp.fromMillis(db.serverNowMs - 5_000),
          expiresAt: FsTimestamp.fromMillis(db.serverNowMs + 120_000),
          safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY',
        },
        merge: false,
      },
    ], uAuth);

    assert.equal(db.rawGet('exposedLocations/uA'), null);
    assert.equal(db.rawGet('emergencyLocationProjections/uA').safetyStatus, 'EMERGENCY');

    db.seed('users/uB', { id: 'uB', name: 'B', role: 'ONI', team: 'B', color: '#3b82f6', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });
    assert.throws(() => db.getDoc('emergencyLocationProjections/uA', { uid: 'uB', signInProvider: 'password' }), RulePermissionError);

    assert.throws(() => {
      db.commitBatch([{
        type: 'set',
        path: 'exposedLocations/uA',
        data: {
          playerId: 'uA', gameSessionId: sessionId, latitude: 35.6, longitude: 139.7,
          capturedAt: SERVER_TIMESTAMP_SENTINEL,
          expiresAt: FsTimestamp.fromMillis(db.serverNowMs + 60_000),
        },
        merge: false,
      }], uAuth);
    }, RulePermissionError);

    db.commitBatch([
      { type: 'update', path: 'users/uA', data: { status: 'RETIRED', waitingUntil: 0, shinkansenStartTime: null, invincibleUntil: 0 } },
      { type: 'delete', path: 'emergencyLocationProjections/uA' },
      { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'ret1', timestamp: db.serverNowMs, message: 'Retired', type: 'EMERGENCY' }, ...db.rawGet('game_config/current').logs] } },
    ], uAuth);
    assert.throws(() => {
      db.commitBatch([
        { type: 'update', path: 'users/uA', data: { status: 'EMERGENCY', waitingUntil: 0, shinkansenStartTime: null, invincibleUntil: 0 } },
      ], uAuth);
    }, RulePermissionError);
  });

  test('shouldThrottleLocationUpdate handles accuracy bounds, distance threshold (30m), min interval (60s), and quiet interval (300s)', () => {
    const base = { latitude: 35.6812, longitude: 139.7671 };
    // High inaccuracy (> 400m default) rejected:
    assert.equal(shouldThrottleLocationUpdate({
      currentCoords: base,
      currentAccuracy: 401,
      currentTimeMs: 1_000_000,
      lastUploadedCoords: null,
      lastUploadedTimeMs: 0,
    }).reason, 'ACCURACY_POOR');

    // Invalid negative accuracy:
    assert.equal(shouldThrottleLocationUpdate({
      currentCoords: base,
      currentAccuracy: -1,
      currentTimeMs: 1_000_000,
      lastUploadedCoords: null,
      lastUploadedTimeMs: 0,
    }).shouldUpload, false);

    // 10s elapsed (< 60s default minInterval) -> TOO_FREQUENT:
    assert.equal(shouldThrottleLocationUpdate({
      currentCoords: { latitude: 35.6820, longitude: 139.7671 },
      currentAccuracy: 10,
      currentTimeMs: 1_010_000,
      lastUploadedCoords: base,
      lastUploadedTimeMs: 1_000_000,
    }).reason, 'TOO_FREQUENT');

    // 60s elapsed + < 30m move -> DISTANCE_BELOW_THRESHOLD:
    assert.equal(shouldThrottleLocationUpdate({
      currentCoords: base,
      currentAccuracy: 10,
      currentTimeMs: 1_060_000,
      lastUploadedCoords: base,
      lastUploadedTimeMs: 1_000_000,
    }).reason, 'DISTANCE_BELOW_THRESHOLD');

    // 60s elapsed + > 30m move -> DISTANCE_EXCEEDED:
    assert.equal(shouldThrottleLocationUpdate({
      currentCoords: { latitude: 35.6816, longitude: 139.7671 },
      currentAccuracy: 10,
      currentTimeMs: 1_060_000,
      lastUploadedCoords: base,
      lastUploadedTimeMs: 1_000_000,
    }).reason, 'DISTANCE_EXCEEDED');

    // 300s elapsed at same spot -> MAX_QUIET_EXCEEDED:
    assert.equal(shouldThrottleLocationUpdate({
      currentCoords: base,
      currentAccuracy: 10,
      currentTimeMs: 1_300_000,
      lastUploadedCoords: base,
      lastUploadedTimeMs: 1_000_000,
    }).reason, 'MAX_QUIET_EXCEEDED');
  });

  test('emergencyLocationHeartbeat ignores poor accuracy > 400m and stops immediately on status leave', async () => {
    const calls = [];
    const timers = [];
    let getPosCb = null;
    const scheduler = {
      setInterval: (cb, delay) => {
        const handle = { cb, delay, cleared: false };
        timers.push(handle);
        return handle;
      },
      clearInterval: handle => {
        handle.cleared = true;
      },
    };
    const ctrl = createEmergencyLocationHeartbeatController();
    try {
      ctrl.sync({
        status: 'EMERGENCY',
        playerId: 'u1',
        expectedSessionId: 's1',
        authUserId: 'u1',
        scheduler,
        geolocation: {
          getCurrentPosition: cb => {
            getPosCb = cb;
          },
        },
        updatePrivateLocation: async input => {
          calls.push(input);
          return { ok: true };
        },
        isCurrentPlayer: () => true,
        isOnline: () => true,
      });

      assert.equal(timers.length, 1);
      assert.ok(getPosCb);
      // Poor accuracy (> 400m) rejected:
      getPosCb({ coords: { latitude: 35.6, longitude: 139.7, accuracy: 450 } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, 0);

      // Trigger interval tick with good accuracy (50m):
      timers[0].cb();
      getPosCb({ coords: { latitude: 35.6, longitude: 139.7, accuracy: 50 } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, 1);

      ctrl.sync({
        status: 'ACTIVE',
        playerId: 'u1',
        expectedSessionId: 's1',
        authUserId: 'u1',
        scheduler,
        geolocation: { getCurrentPosition: () => {} },
        updatePrivateLocation: async () => ({ ok: true }),
        isCurrentPlayer: () => true,
        isOnline: () => true,
      });
      assert.equal(timers[0].cleared, true);
    } finally {
      ctrl.stop();
    }
  });

  test('resolveLocationVisibility covers SELF_PRIVATE, PENALTY, TEAM_A/B, GLOBAL, INDIVIDUAL across all phases', () => {
    const now = 1_750_000_000_000;
    const player = {
      id: 'p1', team: 'A', status: 'ACTIVE',
      privateLatitude: 35.1, privateLongitude: 139.1,
      penaltyRevealUntil: now + 60_000,
      exposedLocation: { gameSessionId: 's1', latitude: 35.2, longitude: 139.2, expiresAt: now + 60_000, revealScope: 'PENALTY' },
    };
    const selfVis = resolveLocationVisibility({
      viewerId: 'p1', player, phase: 'DAY1_ACTIVE', now,
    });
    assert.equal(selfVis.mode, 'SELF_PRIVATE');

    const otherSeesPenalty = resolveLocationVisibility({
      viewerId: 'p2', player, phase: 'DAY1_ACTIVE', now,
    });
    assert.equal(otherSeesPenalty.mode, 'PENALTY_SNAPSHOT');
    assert.equal(otherSeesPenalty.latitude, 35.2);

    const pausedHidden = resolveLocationVisibility({
      viewerId: 'p2', player, phase: 'DAY1_PAUSED', now,
    });
    assert.equal(pausedHidden.mode, 'HIDDEN');
  });

  test('[AUDIT-BUG] auto station/transit check-in labels (e.g., Kobe Port Liner) exceed firestore.rules 100-byte UTF-8 lastStation limit despite passing playerStore length <= 100', () => {
    const stations = JSON.parse(readFileSync(new URL('../../src/data/stations.json', import.meta.url), 'utf8'));
    const kobeCenter = stations.find(s => String(s.name).includes('計算科学センター'));
    assert.ok(kobeCenter, 'Expected 計算科学センター station in stations.json');
    const stationLabel = formatStationLabel(kobeCenter);
    const segmentLabel = formatSegmentLabel('神戸新交通ポートアイランド線', { id: 'a', name: '医療センター' }, kobeCenter, kobeCenter);

    // JS length passes playerStore check (`normalizedStation.length <= 100`):
    assert.ok(stationLabel.length <= 100);
    assert.ok(segmentLabel.length <= 100);

    // Yet Firestore Rules `.size() <= 100` counts UTF-8 bytes and rejects with PERMISSION_DENIED!
    const { db, sessionId } = createActiveParticipantDb();
    db.seed('users/uA', {
      id: 'uA', name: 'A', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
    });
    assert.doesNotThrow(
      () => db.commitBatch([{ type: 'update', path: 'users/uA', data: { lastStation: segmentLabel } }], { uid: 'uA', signInProvider: 'password' }),
      `[AUDIT-BUG] Real Japanese station/transit labels (${Buffer.byteLength(stationLabel, 'utf8')}B station / ${Buffer.byteLength(segmentLabel, 'utf8')}B segment, e.g. ${segmentLabel}) pass JS .length<=100 in playerStore.ts but exceed firestore.rules 100-byte UTF-8 lastStation limit -> PERMISSION_DENIED during auto check-in!`,
    );
  });
});
