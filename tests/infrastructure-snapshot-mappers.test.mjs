import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  mapEmergencyLocationProjection,
  mapExposedLocationDocuments,
  mapGameConfigDocument,
  mapMissionDocuments,
  mapPlayerDocuments,
  mapPrivateLocation,
  mapUserDocument,
} from '../src/infrastructure/firebase/snapshotMappers.ts';

const defaults = {
  gameStatus: 'PRE_GAME',
  teamAScore: 0,
  teamBScore: 0,
  logs: [],
};

describe('Firebase snapshot mappers', () => {
  test('maps document IDs into player and mission records', () => {
    assert.deepEqual(mapUserDocument('uid-1', {
      id: 'spoofed-id', name: 'Player', gameSessionId: 'bad/session', ignored: true,
    }), {
      id: 'uid-1', name: 'Player',
    });
    assert.deepEqual(mapPlayerDocuments([
      { id: 'uid-1', data: { name: 'Player' } },
    ]), [{ id: 'uid-1', name: 'Player' }]);
    assert.deepEqual(mapMissionDocuments([
      { id: 'mission-1', data: { title: 'Mission', ignored: true } },
    ]), [{ id: 'mission-1', title: 'Mission' }]);
  });

  test('keeps legacy Session metadata optional and maps valid Session fields without legacy defaults', () => {
    const legacy = mapGameConfigDocument({ gameStatus: 'PRE_GAME' }, defaults);
    assert.equal('gameSessionId' in legacy, false);
    assert.equal('sessionStartedAt' in legacy, false);
    assert.equal('sessionSchemaVersion' in legacy, false);
    assert.deepEqual(mapGameConfigDocument({
      gameSessionId: 'session-1', sessionStartedAt: 123, sessionSchemaVersion: 2,
    }, defaults), {
      ...defaults, gameSessionId: 'session-1', sessionStartedAt: 123, sessionSchemaVersion: 2,
    });
    const invalid = mapGameConfigDocument({ gameSessionId: '', sessionStartedAt: 'bad', sessionSchemaVersion: -1 }, defaults);
    assert.equal('gameSessionId' in invalid, false);
    assert.equal('sessionStartedAt' in invalid, false);
    assert.equal('sessionSchemaVersion' in invalid, false);
  });

  test('maps missing and existing private-location documents', () => {
    assert.equal(mapPrivateLocation(null), null);
    assert.equal(mapPrivateLocation({ latitude: 35, longitude: 139 }), null);
    assert.deepEqual(mapPrivateLocation({ gameSessionId: 'session-2', latitude: 35, longitude: 139 }), {
      gameSessionId: 'session-2', latitude: 35, longitude: 139,
    });
  });

  test('maps only valid Emergency projection fields to plain numeric timestamps', () => {
    const timestamp = millis => ({ toMillis: () => millis });
    assert.deepEqual(mapEmergencyLocationProjection('uid-1', {
      playerId: 'uid-1', gameSessionId: 'session-2', latitude: 35, longitude: 139,
      projectedAt: timestamp(200), sourceLocationUpdatedAt: timestamp(100), expiresAt: timestamp(300),
      safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY', ignored: 'not mapped',
    }, 'session-2'), {
      playerId: 'uid-1', gameSessionId: 'session-2', latitude: 35, longitude: 139,
      projectedAt: 200, sourceLocationUpdatedAt: 100, expiresAt: 300,
      safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY',
    });
    assert.equal(mapEmergencyLocationProjection('other', {
      playerId: 'uid-1', gameSessionId: 'session-2', latitude: 35, longitude: 139,
      projectedAt: timestamp(200), sourceLocationUpdatedAt: timestamp(100), expiresAt: timestamp(300),
      safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY',
    }, 'different-session'), null);
    assert.equal(mapEmergencyLocationProjection('uid-1', {
      playerId: 'uid-1', gameSessionId: 'session-2', latitude: 91, longitude: 139,
      projectedAt: timestamp(200), sourceLocationUpdatedAt: timestamp(100), expiresAt: timestamp(300),
      safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY',
    }), null);
  });

  test('maps only valid exposed snapshot fields and converts Firestore timestamps', () => {
    const timestamp = millis => ({ toMillis: () => millis });
    assert.deepEqual(mapExposedLocationDocuments([
      { id: 'uid-1', data: {
        playerId: 'uid-1', gameSessionId: 'session-2', latitude: 35, longitude: 139,
        capturedAt: timestamp(50), expiresAt: timestamp(100), revealScope: 'TEAM_A', ignored: 'field',
      } },
      { id: 'uid-2', data: {
        gameSessionId: 'session-2', latitude: 35, longitude: 139, capturedAt: timestamp(50), expiresAt: timestamp(100),
      } },
      { id: 'uid-3', data: {
        latitude: 91, longitude: 139, capturedAt: timestamp(50), expiresAt: timestamp(100),
      } },
      { id: 'uid-4', data: {
        latitude: 35, longitude: 139, capturedAt: timestamp(50), expiresAt: timestamp(100), revealScope: 'INDIVIDUAL',
      } },
      { id: 'uid-5', data: {
        latitude: 35, longitude: 139, capturedAt: timestamp(50), expiresAt: timestamp(100), revealScope: 'UNKNOWN',
      } },
      { id: 'uid-6', data: {
        latitude: 35, longitude: 139, capturedAt: timestamp(50), expiresAt: 100,
      } },
    ], 'session-2'), {
      'uid-1': {
        gameSessionId: 'session-2', latitude: 35, longitude: 139, capturedAt: 50, expiresAt: 100, revealScope: 'TEAM_A',
      },
      'uid-2': {
        gameSessionId: 'session-2', latitude: 35, longitude: 139, capturedAt: 50, expiresAt: 100, revealScope: 'INDIVIDUAL',
      },
    });
  });

  test('merges game config defaults and normalizes missing logs', () => {
    assert.deepEqual(mapGameConfigDocument({ teamAScore: 12 }, defaults), {
      ...defaults,
      teamAScore: 12,
    });
    assert.deepEqual(mapGameConfigDocument({ logs: [{ id: 'log-1' }] }, defaults).logs, [
      { id: 'log-1' },
    ]);
    const config = mapGameConfigDocument({
      locationRevealUntil: { toMillis: () => 200 }, teamARevealUntil: 300,
    }, defaults);
    assert.equal(config.locationRevealUntil, 200);
    assert.equal(config.teamARevealUntil, 300);
  });
});
