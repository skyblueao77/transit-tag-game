import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const firestoreBase = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';

let anonymousToken;
let userAToken;
let userAUid;
let userBToken;
let userBUid;
let userCToken;
let userCUid;
let userDToken;
let userDUid;
let userEToken;
let userEUid;
let unknownViewerToken;
let unknownViewerUid;
let adminToken;
let adminUid;

async function auth(path, body) {
  const response = await fetch(`${authBase}:${path}?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  assert.equal(response.ok, true, `Auth Emulator request failed: ${response.status}`);
  return response.json();
}

async function firestore(documentPath, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${firestoreBase}/${documentPath}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response;
}

function fields(values) {
  return {
    fields: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value === null
          ? { nullValue: null }
          : value instanceof Date
            ? { timestampValue: value.toISOString() }
            : typeof value === 'number'
              ? Number.isInteger(value)
                ? { integerValue: String(value) }
                : { doubleValue: value }
              : typeof value === 'boolean'
                ? { booleanValue: value }
                : { stringValue: value },
      ]),
    ),
  };
}

function privateLocationFields(latitude = 35.6812, longitude = 139.7671) {
  return {
    fields: {
      latitude: { doubleValue: latitude },
      longitude: { doubleValue: longitude },
      updatedAt: { timestampValue: '2026-01-01T00:00:00Z' },
    },
  };
}

function exposedLocationFields(latitude = 35.6812, longitude = 139.7671, extras = {}) {
  const now = Date.now();
  return fields({
    latitude,
    longitude,
    capturedAt: new Date(now - 1_000),
    expiresAt: new Date(extras.expiresAt ?? now + 5 * 60 * 1000),
    ...(extras.revealScope ? { revealScope: extras.revealScope } : {}),
    ...(extras.playerId ? { playerId: extras.playerId } : {}),
  });
}

function emergencyProjectionFields(playerId, { expiresAt = Date.now() + 60_000 } = {}) {
  const projectedAt = Date.now();
  return {
    fields: {
      playerId: { stringValue: playerId },
      latitude: { doubleValue: 35.6812 },
      longitude: { doubleValue: 139.7671 },
      projectedAt: { timestampValue: new Date(projectedAt).toISOString() },
      sourceLocationUpdatedAt: { timestampValue: new Date(projectedAt - 1_000).toISOString() },
      expiresAt: { timestampValue: new Date(expiresAt).toISOString() },
      safetyStatus: { stringValue: 'EMERGENCY' },
      projectionKind: { stringValue: 'EMERGENCY' },
    },
  };
}

async function seed(path, values) {
  const response = await firestore(path, {
    token: 'owner',
    method: 'PATCH',
    body: fields(values),
  });
  assert.equal(response.status, 200, `Seed failed for ${path}: ${response.status}`);
}

before(async () => {
  anonymousToken = (await auth('signUp', {})).idToken;
  const userA = await auth('signUp', {});
  userAToken = userA.idToken;
  userAUid = userA.localId;
  const userB = await auth('signUp', {});
  userBToken = userB.idToken;
  userBUid = userB.localId;
  const userC = await auth('signUp', {});
  userCToken = userC.idToken;
  userCUid = userC.localId;
  const userD = await auth('signUp', {});
  userDToken = userD.idToken;
  userDUid = userD.localId;
  const userE = await auth('signUp', {});
  userEToken = userE.idToken;
  userEUid = userE.localId;
  const unknownViewer = await auth('signUp', {});
  unknownViewerToken = unknownViewer.idToken;
  unknownViewerUid = unknownViewer.localId;
  adminToken = (await auth('signUp', { email: 'admin@example.test', password: 'test-password-123' })).idToken;

  await seed(`users/${userAUid}`, {
    id: userAUid, team: 'A', name: 'User A', status: 'ACTIVE', score: 0, invincibleCards: 1, invincibleUntil: 0,
  });
  await seed(`users/${userBUid}`, {
    id: userBUid, team: 'B', name: 'User B', status: 'ACTIVE', score: 0, invincibleCards: 0, invincibleUntil: 0,
  });
  await seed('missions/mission-1', { title: 'Test mission' });
  await seed('missionCompletions/seed-team-mission', {
    missionId: 'mission-1', team: 'A', completedBy: userAUid, points: 15,
  });
  await seed('game_config/current', { status: 'WAITING' });
  await seed(`users/${unknownViewerUid}`, {
    id: unknownViewerUid, team: 'ADMIN', name: 'Unknown viewer', status: 'ACTIVE', score: 0, invincibleCards: 0,
  });

  adminUid = (await auth('lookup', { idToken: adminToken })).users[0].localId;
  await seed(`admins/${adminUid}`, { role: 'admin' });
});

describe('Firestore Security Rules', () => {
  test('rejects unauthenticated reads and writes', async () => {
    assert.equal((await firestore('users/user-a')).status, 403);
    assert.equal((await firestore('game_config/current', { method: 'PATCH', body: fields({ status: 'RUNNING' }) })).status, 403);
  });

  test('allows an anonymous user to read game data', async () => {
    assert.equal((await firestore(`users/${userAUid}`, { token: anonymousToken })).status, 200);
    assert.equal((await firestore('missions/mission-1', { token: anonymousToken })).status, 200);
    assert.equal((await firestore('game_config/current', { token: anonymousToken })).status, 200);
  });

  test('rejects unauthenticated user creation and coordinate fields in public user documents', async () => {
    const validCreate = {
      id: userDUid, team: 'A', name: 'User D', status: 'ACTIVE', score: 0, invincibleCards: 0,
    };
    assert.equal((await firestore(`users/${userDUid}`, {
      method: 'PATCH',
      body: fields(validCreate),
    })).status, 403);

    for (const coordinateFields of [
      { privateLatitude: 35 },
      { privateLongitude: 139 },
      { privateLatitude: 35, privateLongitude: 139 },
      { latitude: 35 },
      { longitude: 139 },
      { lastLat: 35 },
      { lastLng: 139 },
    ]) {
      assert.equal((await firestore(`users/${userDUid}`, {
        token: userDToken,
        method: 'PATCH',
        body: fields({ ...validCreate, ...coordinateFields }),
      })).status, 403);
    }

    assert.equal((await firestore(`users/${userCUid}`, {
      token: userCToken,
      method: 'PATCH',
      body: fields({
        id: userCUid, team: 'A', name: 'User C', status: 'ACTIVE', score: 0, invincibleCards: 0,
      }),
    })).status, 200);
  });

  test('allows a user to update their own valid user document', async () => {
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({
        id: userAUid, team: 'A', name: 'Updated A', status: 'ACTIVE', score: 0,
        invincibleCards: 1, invincibleUntil: 0,
      }),
    })).status, 200);
  });

  test('blocks private coordinates in owner and administrator user writes', async () => {
    for (const coordinateFields of [
      { privateLatitude: 35 },
      { privateLongitude: 139 },
      { privateLatitude: 35, privateLongitude: 139 },
      { latitude: 35 },
      { longitude: 139 },
    ]) {
      assert.equal((await firestore(`users/${userAUid}`, {
        token: userAToken,
        method: 'PATCH',
        body: fields(coordinateFields),
      })).status, 403);
      assert.equal((await firestore(`users/${userBUid}`, {
        token: adminToken,
        method: 'PATCH',
        body: fields(coordinateFields),
      })).status, 403);
    }

    await seed(`users/${userEUid}`, {
      id: userEUid, team: 'A', name: 'User E', status: 'ACTIVE', score: 0,
      invincibleCards: 0, privateLatitude: 35,
    });
    assert.equal((await firestore(`users/${userEUid}`, {
      token: userEToken,
      method: 'PATCH',
      body: fields({
        id: userEUid, team: 'A', name: 'User E', status: 'ACTIVE', score: 0,
        invincibleCards: 0, privateLatitude: 36,
      }),
    })).status, 403);

    assert.equal((await firestore(`users/${userBUid}`, {
      token: adminToken,
      method: 'PATCH',
      body: fields({ name: 'Updated by admin' }),
    })).status, 200);
  });

  test('prevents a user from changing another user document', async () => {
    assert.equal((await firestore(`users/${userBUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ id: userBUid, team: 'A', name: 'Tampered' }),
    })).status, 403);
  });

  test('prevents owners from changing their team after setup', async () => {
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({
        id: userAUid, team: 'B', name: 'User A', status: 'ACTIVE', score: 0,
        invincibleCards: 1, invincibleUntil: 0,
      }),
    })).status, 403);
  });

  test('blocks owner direct status writes while preserving Admin status operations', async () => {
    const ownerStatuses = ['ACTIVE', 'WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED'];
    for (const status of ownerStatuses) {
      assert.equal((await firestore(`users/${userAUid}`, {
        token: userAToken, method: 'PATCH', body: fields({ status }),
      })).status, 403, `Owner status ${status} should be denied`);
    }
    const adminUser = status => fields({
      id: userBUid, team: 'B', name: 'User B', status, score: 0,
      invincibleCards: 0, invincibleUntil: 0,
    });
    assert.equal((await firestore(`users/${userBUid}`, {
      token: adminToken, method: 'PATCH', body: adminUser('EMERGENCY'),
    })).status, 200);
    assert.equal((await firestore(`users/${userBUid}`, {
      token: adminToken, method: 'PATCH', body: adminUser('RETIRED'),
    })).status, 200);
    assert.equal((await firestore(`users/${userBUid}`, {
      token: adminToken, method: 'PATCH', body: adminUser('ACTIVE'),
    })).status, 200);
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({
        id: userAUid, team: 'A', name: 'Still editable', status: 'ACTIVE', score: 0,
        invincibleCards: 1, invincibleUntil: 0,
      }),
    })).status, 200);
  });

  test('blocks owner Waiting authority while keeping status unchanged', async () => {
    const futureDeadline = Date.now() + 60 * 60 * 1000;
    for (const body of [
      fields({ status: 'WAITING' }),
      fields({ waitingUntil: futureDeadline }),
      fields({ shinkansenStartTime: Date.now() }),
      fields({ status: 'EMERGENCY', waitingUntil: futureDeadline }),
      fields({ status: 'RETIRED', shinkansenStartTime: Date.now() }),
    ]) {
      assert.equal((await firestore(`users/${userAUid}`, {
        token: userAToken, method: 'PATCH', body,
      })).status, 403);
    }


    assert.equal((await firestore(`users/${userCUid}`, {
      token: userCToken,
      method: 'PATCH',
      body: fields({
        id: userCUid, team: 'A', name: 'New player', status: 'ACTIVE', score: 0,
        invincibleCards: 0, waitingUntil: futureDeadline, shinkansenStartTime: Date.now(),
      }),
    })).status, 403);
  });

  test('prevents owner and other-player score writes', async () => {
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ score: 1000 }),
    })).status, 403);
    assert.equal((await firestore(`users/${userBUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ score: 1000 }),
    })).status, 403);
    assert.equal((await firestore('game_config/current', {
      token: userAToken,
      method: 'PATCH',
      body: fields({ teamAScore: 1000 }),
    })).status, 403);
  });

  test('denies all owner Powerup field writes and preserves Admin writes', async () => {
    const futureDeadline = Date.now() + 30 * 60 * 1000;
    for (const [token, path, body] of [
      [userAToken, `users/${userAUid}`, fields({ invincibleCards: 0 })],
      [userAToken, `users/${userAUid}`, fields({ invincibleUntil: futureDeadline })],
      [userAToken, `users/${userAUid}`, fields({ invincibleCards: 0, invincibleUntil: futureDeadline })],
      [userAToken, `users/${userAUid}`, fields({ invincibleCards: 2 })],
      [userBToken, `users/${userBUid}`, fields({ invincibleCards: -1 })],
      [userAToken, `users/${userBUid}`, fields({ invincibleCards: 1, invincibleUntil: futureDeadline })],
    ]) {
      assert.equal((await firestore(path, { token, method: 'PATCH', body })).status, 403);
    }

    assert.equal((await firestore(`users/${userBUid}`, {
      token: adminToken,
      method: 'PATCH',
      body: fields({ invincibleCards: 2, invincibleUntil: futureDeadline }),
    })).status, 200);
  });

  test('mission completion records are readable by participants and never client-writable', async () => {
    assert.equal((await firestore('missionCompletions/seed-team-mission')).status, 403);
    assert.equal((await firestore('missionCompletions/seed-team-mission', {
      token: userAToken,
    })).status, 200);
    assert.equal((await firestore('missionCompletions/new-record', {
      token: userAToken,
      method: 'PATCH',
      body: fields({ missionId: 'mission-1', team: 'A' }),
    })).status, 403);
    assert.equal((await firestore('missionCompletions/seed-team-mission', {
      token: userAToken,
      method: 'PATCH',
      body: fields({ points: 999 }),
    })).status, 403);
    assert.equal((await firestore('missionCompletions/seed-team-mission', {
      token: userAToken,
      method: 'DELETE',
    })).status, 403);
  });

  test('protects private locations by owner and admin access', async () => {
    assert.equal((await firestore(`privateLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: privateLocationFields(0, 0),
    })).status, 200);
    assert.equal((await firestore(`privateLocations/${userAUid}`, { token: userAToken })).status, 200);
    assert.equal((await firestore(`privateLocations/${userAUid}`, { token: userBToken })).status, 403);
    assert.equal((await firestore(`privateLocations/${userAUid}`, {
      token: userBToken,
      method: 'PATCH',
      body: privateLocationFields(1, 1),
    })).status, 403);
    assert.equal((await firestore(`privateLocations/${userAUid}`, { token: adminToken })).status, 200);
    assert.equal((await firestore(`privateLocations/${userAUid}`, {
      token: adminToken,
      method: 'PATCH',
      body: privateLocationFields(2, 2),
    })).status, 403);
    assert.equal((await firestore(`privateLocations/${userAUid}`, {
      token: userAToken,
      method: 'DELETE',
    })).status, 403);
    assert.equal((await firestore(`privateLocations/${userAUid}`, {
      token: adminToken,
      method: 'DELETE',
    })).status, 403);
    assert.equal((await firestore(`privateLocations/${userAUid}`)).status, 403);
  });

  test('rejects unauthenticated and cross-player private location writes', async () => {
    assert.equal((await firestore(`privateLocations/${userBUid}`, {
      method: 'PATCH',
      body: privateLocationFields(1, 1),
    })).status, 403);
    assert.equal((await firestore(`privateLocations/${userAUid}`, {
      method: 'PATCH',
      body: privateLocationFields(1, 1),
    })).status, 403);
    assert.equal((await firestore(`privateLocations/${userBUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: privateLocationFields(1, 1),
    })).status, 403);
  });

  test('enforces private location coordinate boundaries and field allowlist', async () => {
    for (const [latitude, longitude] of [[91, 0], [-91, 0], [0, 181], [0, -181]]) {
      assert.equal((await firestore(`privateLocations/${userBUid}`, {
        token: userBToken,
        method: 'PATCH',
        body: privateLocationFields(latitude, longitude),
      })).status, 403);
    }

    for (const [latitude, longitude] of [[90, 180], [-90, -180], [0, 0]]) {
      assert.equal((await firestore(`privateLocations/${userBUid}`, {
        token: userBToken,
        method: 'PATCH',
        body: privateLocationFields(latitude, longitude),
      })).status, 200);
    }

    assert.equal((await firestore(`privateLocations/${userBUid}`, {
      token: userBToken,
      method: 'PATCH',
      body: {
        fields: {
          latitude: { doubleValue: 1 },
          longitude: { doubleValue: 1 },
          updatedAt: { timestampValue: '2026-01-01T00:00:00Z' },
          role: { stringValue: 'ONI' },
        },
      },
    })).status, 403);
  });

  test('protects exposed location snapshots and rejects legacy snapshot fields', async () => {
    await seed(`users/${userAUid}`, {
      id: userAUid, team: 'A', name: 'User A', status: 'ACTIVE', score: 0, invincibleCards: 1, invincibleUntil: 0,
    });
    await seed(`users/${userBUid}`, {
      id: userBUid, team: 'B', name: 'User B', status: 'ACTIVE', score: 0, invincibleCards: 0, invincibleUntil: 0,
    });
    await seed('game_config/current', { gameStatus: 'DAY1_ACTIVE' });
    assert.equal((await firestore(`exposedLocations/${userAUid}`)).status, 403);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, { token: userAToken })).status, 404);

    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: exposedLocationFields(0, 0),
    })).status, 200);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userBToken,
      method: 'PATCH',
      body: exposedLocationFields(1, 1),
    })).status, 403);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, { token: userAToken })).status, 200);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, { token: userBToken })).status, 200);
    assert.equal((await firestore('exposedLocations', { token: userAToken })).status, 403);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, { token: adminToken })).status, 200);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, { token: unknownViewerToken })).status, 403);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: adminToken,
      method: 'PATCH',
      body: exposedLocationFields(2, 2),
    })).status, 403);
    for (const [latitude, longitude] of [[91, 0], [-91, 0], [0, 181], [0, -181]]) {
      assert.equal((await firestore(`exposedLocations/${userAUid}`, {
        token: userAToken,
        method: 'PATCH',
        body: exposedLocationFields(latitude, longitude),
      })).status, 403);
    }
    for (const [latitude, longitude] of [[90, 180], [-90, -180], [0, 0]]) {
      assert.equal((await firestore(`exposedLocations/${userAUid}`, {
        token: userAToken,
        method: 'PATCH',
        body: exposedLocationFields(latitude, longitude),
      })).status, 200);
    }
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({
        latitude: 1, longitude: 1, capturedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000), role: 'ONI',
      }),
    })).status, 403);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: exposedLocationFields(1, 1, { expiresAt: Date.now() - 1 }),
    })).status, 403);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: exposedLocationFields(1, 1, { expiresAt: Date.now() + 6 * 60_000 }),
    })).status, 403);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: exposedLocationFields(1, 1, { revealScope: 'GLOBAL' }),
    })).status, 403);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userAToken,
      method: 'DELETE',
    })).status, 403);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: adminToken,
      method: 'DELETE',
    })).status, 403);

    assert.equal((await firestore(`users/${userCUid}`, {
      token: userCToken,
      method: 'PATCH',
      body: fields({ id: userCUid, team: 'A', name: 'User C', exposedLat: 1 }),
    })).status, 403);
    assert.equal((await firestore(`users/${userDUid}`, {
      token: userDToken,
      method: 'PATCH',
      body: fields({ id: userDUid, team: 'A', name: 'User D', exposedLng: 1 }),
    })).status, 403);
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ locationExposedUntil: 1 }),
    })).status, 403);

    await seed('users/' + userBUid, {
      id: userBUid, team: 'B', name: 'User B', status: 'ACTIVE', score: 0, invincibleCards: 0,
    });
    await seed('game_config/current', {
      gameStatus: 'DAY1_ACTIVE', teamARevealUntil: new Date(Date.now() + 60_000),
    });
    await seed(`exposedLocations/${userAUid}`, {
      latitude: 35.1, longitude: 139.1, playerId: userAUid,
      capturedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), revealScope: 'TEAM_A',
    });
    assert.equal((await firestore(`exposedLocations/${userAUid}`, { token: userBToken })).status, 200);
    await seed(`exposedLocations/${userBUid}`, {
      latitude: 35.1, longitude: 139.1, playerId: userBUid,
      capturedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), revealScope: 'TEAM_A',
    });
    assert.equal((await firestore(`exposedLocations/${userBUid}`, { token: userAToken })).status, 403);

    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: exposedLocationFields(2, 2),
    })).status, 403, 'Owner cannot replace a live Admin-scoped snapshot');
    await seed(`exposedLocations/${userAUid}`, {
      latitude: 35.1, longitude: 139.1, playerId: userAUid,
      capturedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1), revealScope: 'TEAM_A',
    });
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: exposedLocationFields(2, 2),
    })).status, 200, 'Owner can replace an expired Admin snapshot');

    await seed(`users/${userEUid}`, {
      id: userEUid, team: 'A', name: 'User E', status: 'ACTIVE', score: 0, invincibleCards: 0,
    });
    await seed(`exposedLocations/${userEUid}`, {
      latitude: 35.1, longitude: 139.1, playerId: userEUid,
      capturedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1), revealScope: 'TEAM_A',
    });
    assert.equal((await firestore(`exposedLocations/${userEUid}`, { token: userAToken })).status, 403);
    await seed(`exposedLocations/${userEUid}`, {
      latitude: 35.1, longitude: 139.1, playerId: userEUid,
      capturedAt: new Date(), expiresAt: Date.now() + 60_000, revealScope: 'TEAM_A',
    });
    assert.equal((await firestore(`exposedLocations/${userEUid}`, { token: userAToken })).status, 403);
    await seed(`exposedLocations/${userEUid}`, {
      latitude: 35.1, longitude: 139.1, playerId: userEUid,
      capturedAt: new Date(Date.now() - 1_000), revealScope: 'TEAM_A',
    });
    assert.equal((await firestore(`exposedLocations/${userEUid}`, { token: userAToken })).status, 403);
    await seed(`exposedLocations/${userEUid}`, {
      latitude: 35.1, longitude: 139.1, playerId: userEUid,
      capturedAt: new Date(Date.now() - 1_000), expiresAt: new Date(Date.now() + 60_000),
      revealScope: 'INDIVIDUAL',
    });
    assert.equal((await firestore(`exposedLocations/${userEUid}`, { token: userAToken })).status, 403);
  });

  test('rejects legacy private GPS fields in public user documents', async () => {
    assert.equal((await firestore(`users/${userCUid}`, {
      token: userCToken,
      method: 'PATCH',
      body: fields({ id: userCUid, team: 'A', name: 'User C', lastLat: 1 }),
    })).status, 403);
    assert.equal((await firestore(`users/${userDUid}`, {
      token: userDToken,
      method: 'PATCH',
      body: fields({ id: userDUid, team: 'A', name: 'User D', lastLng: 1 }),
    })).status, 403);
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ lastLat: 1 }),
    })).status, 403);
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ lastLng: 1 }),
    })).status, 403);
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ latitude: 1 }),
    })).status, 403);
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ longitude: 1 }),
    })).status, 403);
  });

  test('prevents regular users from changing game_config or missions', async () => {
    assert.equal((await firestore('game_config/current', {
      token: anonymousToken,
      method: 'PATCH',
      body: fields({ status: 'RUNNING' }),
    })).status, 403);
    assert.equal((await firestore('missions/mission-1', {
      token: anonymousToken,
      method: 'PATCH',
      body: fields({ title: 'Tampered' }),
    })).status, 403);
  });

  test('prevents regular users from creating or changing admin documents', async () => {
    assert.equal((await firestore(`admins/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ role: 'admin' }),
    })).status, 403);
    assert.equal((await firestore(`admins/${userBUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ role: 'admin' }),
    })).status, 403);
  });

  test('restricts Emergency projections to Admin reads while active and denies every client write', async () => {
    assert.equal((await firestore(`users/${userDUid}`, {
      token: userDToken,
      method: 'PATCH',
      body: fields({
        id: userDUid, team: 'A', name: 'Projection Player', status: 'ACTIVE', score: 0,
        invincibleCards: 0,
      }),
    })).status, 200);
    assert.equal((await firestore(`users/${userDUid}`, {
      token: adminToken,
      method: 'PATCH',
      body: fields({ status: 'EMERGENCY' }),
    })).status, 200);

    const path = `emergencyLocationProjections/${userDUid}`;
    const freshProjection = emergencyProjectionFields(userDUid);
    assert.equal((await firestore(path, { method: 'PATCH', body: freshProjection })).status, 403);
    assert.equal((await firestore(path, { token: userDToken, method: 'PATCH', body: freshProjection })).status, 403);
    assert.equal((await firestore(path, { token: adminToken, method: 'PATCH', body: freshProjection })).status, 403);

    assert.equal((await firestore(path, { token: 'owner', method: 'PATCH', body: freshProjection })).status, 200);
    for (const token of [userDToken, adminToken]) {
      assert.equal((await firestore(path, {
        token,
        method: 'PATCH',
        body: emergencyProjectionFields(userDUid),
      })).status, 403);
    }
    assert.equal((await firestore(path)).status, 403);
    assert.equal((await firestore(path, { token: userDToken })).status, 403);
    assert.equal((await firestore(path, { token: adminToken })).status, 200);
    for (const token of [userDToken, adminToken]) {
      assert.equal((await firestore(path, { token, method: 'DELETE' })).status, 403);
    }

    await firestore(path, {
      token: 'owner',
      method: 'PATCH',
      body: emergencyProjectionFields(userDUid, { expiresAt: Date.now() - 1 }),
    });
    assert.equal((await firestore(path, { token: adminToken })).status, 403);

    await firestore(`users/${userDUid}`, {
      token: adminToken,
      method: 'PATCH',
      body: fields({ status: 'RETIRED' }),
    });
    assert.equal((await firestore(path, { token: adminToken })).status, 403);
  });

  test('Admin client cannot set or extend Reveal deadlines and may clear them for Reset', async () => {
    const initial = Date.now() + 120_000;
    const later = Date.now() + 300_000;
    const deadlineFields = {
      locationRevealUntil: new Date(initial),
      teamARevealUntil: new Date(initial + 1_000),
      teamBRevealUntil: new Date(initial + 2_000),
    };

    for (const field of Object.keys(deadlineFields)) {
      await seed('game_config/current', { gameStatus: 'DAY1_ACTIVE' });
      assert.equal((await firestore('game_config/current', {
        token: adminToken,
        method: 'PATCH',
        body: fields({ [field]: new Date(later) }),
      })).status, 403, `Admin cannot set ${field}`);
    }

    await seed('game_config/current', {
      gameStatus: 'DAY1_ACTIVE', ...deadlineFields,
    });
    assert.equal((await firestore('game_config/current', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ locationRevealUntil: new Date(later) }),
    })).status, 403, 'Admin cannot extend an existing Reveal deadline');

    assert.equal((await firestore('game_config/current', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ gameStatus: 'DAY1_ACTIVE', announcement: 'ordinary update', ...deadlineFields }),
    })).status, 200, 'Admin may update unrelated Config fields with unchanged deadlines');

    const reset = await firestore('game_config/current', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ gameStatus: 'PRE_GAME' }),
    });
    assert.equal(reset.status, 200, 'Reset may clear Reveal deadlines');
    const resetConfig = await reset.json();
    for (const field of Object.keys(deadlineFields)) {
      assert.equal(resetConfig.fields?.[field], undefined, `Reset removes ${field}`);
    }
  });

  test('allows an administrator to perform management writes', async () => {
    assert.equal((await firestore('game_config/current', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ status: 'RUNNING' }),
    })).status, 200);
    assert.equal((await firestore('game_config/current', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ announcement: 'Updated by Admin' }),
    })).status, 200);
    assert.equal((await firestore('missions/mission-1', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ title: 'Updated mission' }),
    })).status, 200);
    assert.equal((await firestore(`users/${userBUid}`, {
      token: adminToken,
      method: 'PATCH',
      body: fields({ status: 'WAITING', waitingUntil: Date.now() + 60 * 60 * 1000, shinkansenStartTime: null }),
    })).status, 200);
    assert.equal((await firestore(`users/${userBUid}`, {
      token: adminToken,
      method: 'DELETE',
    })).status, 200);
  });

  test('rejects access to undefined collections', async () => {
    assert.equal((await firestore('not_defined/document', { token: anonymousToken })).status, 403);
    assert.equal((await firestore('not_defined/document', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ value: 'blocked' }),
    })).status, 403);
  });
});
