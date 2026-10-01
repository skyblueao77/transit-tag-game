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
    assert.deepEqual(mapUserDocument('uid-1', { name: 'Player' }), {
      id: 'uid-1', name: 'Player',
    });
    assert.deepEqual(mapPlayerDocuments([
      { id: 'uid-1', data: { name: 'Player' } },
    ]), [{ id: 'uid-1', name: 'Player' }]);
    assert.deepEqual(mapMissionDocuments([
      { id: 'mission-1', data: { title: 'Mission' } },
    ]), [{ id: 'mission-1', title: 'Mission' }]);
  });

  test('maps missing and existing private-location documents', () => {
    assert.equal(mapPrivateLocation(null), null);
    assert.deepEqual(mapPrivateLocation({ latitude: 35, longitude: 139 }), {
      latitude: 35, longitude: 139,
    });
  });

  test('maps only valid Emergency projection fields to plain numeric timestamps', () => {
    const timestamp = millis => ({ toMillis: () => millis });
    assert.deepEqual(mapEmergencyLocationProjection('uid-1', {
      playerId: 'uid-1', latitude: 35, longitude: 139,
      projectedAt: timestamp(200), sourceLocationUpdatedAt: timestamp(100), expiresAt: timestamp(300),
      safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY', ignored: 'not mapped',
    }), {
      playerId: 'uid-1', latitude: 35, longitude: 139,
      projectedAt: 200, sourceLocationUpdatedAt: 100, expiresAt: 300,
      safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY',
    });
    assert.equal(mapEmergencyLocationProjection('other', {
      playerId: 'uid-1', latitude: 35, longitude: 139,
      projectedAt: timestamp(200), sourceLocationUpdatedAt: timestamp(100), expiresAt: timestamp(300),
      safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY',
    }), null);
    assert.equal(mapEmergencyLocationProjection('uid-1', {
      playerId: 'uid-1', latitude: 91, longitude: 139,
      projectedAt: timestamp(200), sourceLocationUpdatedAt: timestamp(100), expiresAt: timestamp(300),
      safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY',
    }), null);
  });

  test('maps exposed location documents by UID', () => {
    assert.deepEqual(mapExposedLocationDocuments([
      { id: 'uid-1', data: { latitude: 35, longitude: 139, expiresAt: 100 } },
    ]), {
      'uid-1': { latitude: 35, longitude: 139, expiresAt: 100 },
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
  });
});
