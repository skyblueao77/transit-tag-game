import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const firestoreBase = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';

const CURRENT_SESSION_ID = 'session_rules_current';
const SESSION_STARTED_AT = 1_800_000_000_000;
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

async function commitBatch(writes, token) {
  const response = await fetch(`http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ writes }),
  });
  if (response.status !== 200) {
    const text = await response.text();
    console.error('commitBatch error (status ' + response.status + '):', text);
  }
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
                : Array.isArray(value)
                  ? value.length === 0
                    ? { arrayValue: {} }
                    : { arrayValue: { values: value.map(v => (typeof v === 'string' ? { stringValue: v } : fields(v))) } }
                  : { stringValue: value },
      ]),
    ),
  };
}

function privateLocationFields(latitude = 35.6812, longitude = 139.7671, gameSessionId = CURRENT_SESSION_ID) {
  return {
    fields: {
      gameSessionId: { stringValue: gameSessionId },
      latitude: { doubleValue: latitude },
      longitude: { doubleValue: longitude },
      updatedAt: { timestampValue: '2026-01-01T00:00:00Z' },
    },
  };
}

function exposedLocationFields(latitude = 35.6812, longitude = 139.7671, extras = {}) {
  const now = Date.now();
  return fields({
    gameSessionId: extras.gameSessionId ?? CURRENT_SESSION_ID,
    latitude,
    longitude,
    capturedAt: new Date(now - 1_000),
    expiresAt: new Date(extras.expiresAt ?? now + 5 * 60 * 1000),
    ...(extras.revealScope ? { revealScope: extras.revealScope } : {}),
    ...(extras.playerId ? { playerId: extras.playerId } : {}),
  });
}

function emergencyProjectionFields(playerId, { expiresAt = Date.now() + 60_000, gameSessionId = CURRENT_SESSION_ID } = {}) {
  const projectedAt = Date.now();
  return {
    fields: {
      playerId: { stringValue: playerId },
      gameSessionId: { stringValue: gameSessionId },
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
  if (response.status !== 200) {
    const text = await response.text();
    console.error(`Seed failed for ${path} (${response.status}):`, text);
  }
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

  adminUid = (await auth('lookup', { idToken: adminToken })).users[0].localId;
  await seed(`admins/${adminUid}`, { role: 'admin' });

  await seed('game_config/current', {
    gameStatus: 'DAY1_ACTIVE',
    gameSessionId: CURRENT_SESSION_ID,
    sessionStartedAt: SESSION_STARTED_AT,
    sessionSchemaVersion: 2,
    day: 1,
    missionMode: 'SEPARATE',
    isGameOver: false,
    teamARole: 'RUNNER',
    teamBRole: 'ONI',
    teamAScore: 100,
    teamBScore: 50,
    logs: [],
  });

  await seed(`users/${userAUid}`, {
    id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', name: 'User A', role: 'RUNNER', color: '#ef4444', status: 'ACTIVE', score: 0, invincibleCards: 1, invincibleUntil: 0,
  });
  await seed(`users/${userBUid}`, {
    id: userBUid, gameSessionId: CURRENT_SESSION_ID, team: 'B', name: 'User B', role: 'RUNNER', color: '#3b82f6', status: 'ACTIVE', score: 0, invincibleCards: 0, invincibleUntil: 0,
  });
  await seed('missions/mission-1', { id: 'mission-1', title: 'Test mission 1', points: 20 });
  await seed('missions/mission-2', { id: 'mission-2', title: 'Test mission 2', points: 30 });

  const seedCompletionId = `A_${CURRENT_SESSION_ID}_mission-1`;
  await seed(`missionCompletions/${seedCompletionId}`, {
    gameSessionId: CURRENT_SESSION_ID, missionId: 'mission-1', team: 'A', completedBy: userAUid, points: 20, isFinalMission: false,
  });

  await seed(`users/${unknownViewerUid}`, {
    id: unknownViewerUid, team: 'ADMIN', name: 'Unknown viewer', role: 'RUNNER', color: '#000000', status: 'ACTIVE', score: 0, invincibleCards: 0,
  });
});

describe('Firestore Security Rules', () => {
  test('rejects unauthenticated reads and writes', async () => {
    assert.equal((await firestore(`users/${userAUid}`)).status, 403);
    assert.equal((await firestore('game_config/current', { method: 'PATCH', body: fields({ status: 'RUNNING' }) })).status, 403);
  });

  test('allows an anonymous user to read public game data', async () => {
    assert.equal((await firestore(`users/${userAUid}`, { token: anonymousToken })).status, 200);
    assert.equal((await firestore('missions/mission-1', { token: anonymousToken })).status, 200);
    assert.equal((await firestore('game_config/current', { token: anonymousToken })).status, 200);
  });

  test('rejects unauthenticated user creation and coordinate fields in public user documents', async () => {
    const validCreate = {
      id: userDUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', name: 'User D', role: 'RUNNER',
      color: '#ef4444', status: 'ACTIVE', score: 0, invincibleCards: 0,
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
        id: userCUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', name: 'User C', role: 'RUNNER', color: '#ef4444',
        status: 'ACTIVE', score: 0, invincibleCards: 0,
      }),
    })).status, 200);
  });

  test('allows a user to update only their own profile name', async () => {
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({
        id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'Updated A', color: '#ef4444', status: 'ACTIVE', score: 0,
        invincibleCards: 1, invincibleUntil: 0,
      }),
    })).status, 200);
  });

  test('allows only strict current-Session Setup create and rejects Admin creating Player doc', async () => {
    const validPlayer = {
      id: userDUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', name: 'Setup Player',
      role: 'RUNNER', color: '#ef4444', status: 'ACTIVE', score: 0, invincibleCards: 0,
    };
    for (const invalid of [
      { ...validPlayer, gameSessionId: 'stale-session' },
      { ...validPlayer, team: 'ADMIN' },
      { ...validPlayer, role: 'ONI' },
      { ...validPlayer, status: 'WAITING' },
      { ...validPlayer, score: 1 },
      { ...validPlayer, invincibleCards: 1 },
      { ...validPlayer, latitude: 35 },
      { ...validPlayer, isAdmin: true },
      Object.fromEntries(Object.entries(validPlayer).filter(([key]) => key !== 'color')),
    ]) {
      assert.equal((await firestore(`users/${userDUid}`, {
        token: userDToken, method: 'PATCH', body: fields(invalid),
      })).status, 403);
    }
    assert.equal((await firestore(`users/${adminUid}`, {
      token: adminToken, method: 'PATCH', body: fields({ ...validPlayer, id: adminUid }),
    })).status, 403, 'Admin Auth cannot create a Player document');
    assert.equal((await firestore(`users/${userDUid}`, {
      token: userDToken, method: 'PATCH', body: fields(validPlayer),
    })).status, 200);
  });

  test('rejects owner changes to role, session, coordinates, and authority fields', async () => {
    for (const update of [
      { role: 'ONI' },
      { gameSessionId: 'client-session' },
      { color: '#000000' },
      { status: 'RETIRED' },
      { score: 9 },
      { invincibleCards: 9 },
      { invincibleUntil: Date.now() + 10_000 },
      { waitingUntil: Date.now() + 10_000 },
      { shinkansenStartTime: Date.now() },
      { latitude: 35 },
    ]) {
      assert.equal((await firestore(`users/${userAUid}`, {
        token: userAToken, method: 'PATCH', body: fields({ id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'User A', status: 'ACTIVE', score: 0, invincibleCards: 1, ...update }),
      })).status, 403);
    }
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
        body: fields({ id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'User A', status: 'ACTIVE', score: 0, invincibleCards: 1, ...coordinateFields }),
      })).status, 403);
      assert.equal((await firestore(`users/${userBUid}`, {
        token: adminToken,
        method: 'PATCH',
        body: fields({ id: userBUid, gameSessionId: CURRENT_SESSION_ID, team: 'B', role: 'RUNNER', name: 'User B', status: 'ACTIVE', score: 0, invincibleCards: 0, ...coordinateFields }),
      })).status, 403);
    }
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
        id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'B', role: 'RUNNER', name: 'User A', status: 'ACTIVE', score: 0,
        invincibleCards: 1,
      }),
    })).status, 403);
  });

  test('blocks owner and other-player score writes without verified completion transaction', async () => {
    // P1 Exploit Prevention: direct score increment by player must be 403!
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'User A', status: 'ACTIVE', score: 100, invincibleCards: 1 }),
    })).status, 403);
    assert.equal((await firestore(`users/${userBUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ id: userBUid, gameSessionId: CURRENT_SESSION_ID, team: 'B', role: 'RUNNER', name: 'User B', status: 'ACTIVE', score: 100, invincibleCards: 0 }),
    })).status, 403);
    assert.equal((await firestore('game_config/current', {
      token: userAToken,
      method: 'PATCH',
      body: fields({ teamAScore: 1000 }),
    })).status, 403);
  });

  let activeUntil;

  test('denies owner arbitrary Powerup card increment without lucky reward', async () => {
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'Updated A', status: 'ACTIVE', score: 0, invincibleCards: 2 }),
    })).status, 403);
  });

  test('allows Runner to activate invincibility card when cards available', async () => {
    const now = Date.now();
    activeUntil = now + 10 * 60 * 1000;
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({
        id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'Updated A', color: '#ef4444', status: 'ACTIVE', score: 0,
        invincibleCards: 0, invincibleUntil: activeUntil,
      }),
    })).status, 200);
  });

  test('protects private locations: owner only access, denies admin read and cross-player access', async () => {
    assert.equal((await firestore(`privateLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: privateLocationFields(35.68, 139.76),
    })).status, 200);
    assert.equal((await firestore(`privateLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: privateLocationFields(0, 0, 'old-session'),
    })).status, 403);
    assert.equal((await firestore(`privateLocations/${userAUid}`, { token: userAToken })).status, 200);
    assert.equal((await firestore(`privateLocations/${userAUid}`, { token: userBToken })).status, 403);
    assert.equal((await firestore(`privateLocations/${userAUid}`, { token: adminToken })).status, 403, 'Admin cannot read private locations');
    assert.equal((await firestore(`privateLocations/${userAUid}`, {
      token: adminToken,
      method: 'PATCH',
      body: privateLocationFields(2, 2),
    })).status, 403);
  });

  test('protects exposed location snapshots', async () => {
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: exposedLocationFields(35.68, 139.76),
    })).status, 200);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, { token: userBToken })).status, 200);
    assert.equal((await firestore(`exposedLocations/${userAUid}`, {
      token: adminToken,
      method: 'PATCH',
      body: exposedLocationFields(35.68, 139.76),
    })).status, 403, 'Admin Client cannot directly spoof exposed location');
  });

  test('restricts Emergency projections to Admin reads and validates user Emergency write', async () => {
    await seed(`users/${userDUid}`, {
      id: userDUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', name: 'Projection Player', role: 'RUNNER',
      color: '#ef4444', status: 'EMERGENCY', score: 0, invincibleCards: 0,
    });

    const path = `emergencyLocationProjections/${userDUid}`;
    const freshProjection = emergencyProjectionFields(userDUid);
    assert.equal((await firestore(path, { token: userDToken, method: 'PATCH', body: freshProjection })).status, 200);
    assert.equal((await firestore(path, { token: adminToken })).status, 200, 'Admin can read Emergency location');
    assert.equal((await firestore(path, { token: userBToken })).status, 403, 'Other players cannot read Emergency projection');
  });

  test('allows Administrator in Spark plan to manage game_config, missions, and receipts', async () => {
    // Admin managing game_config
    assert.equal((await firestore('game_config/current', {
      token: adminToken,
      method: 'PATCH',
      body: fields({
        gameStatus: 'DAY1_ACTIVE',
        gameSessionId: CURRENT_SESSION_ID,
        sessionStartedAt: SESSION_STARTED_AT,
        sessionSchemaVersion: 2,
        day: 1,
        missionMode: 'SEPARATE',
        isGameOver: false,
        teamARole: 'RUNNER',
        teamBRole: 'ONI',
        teamAScore: 120,
        teamBScore: 50,
        logs: [],
      }),
    })).status, 200);

    // Admin creating / updating mission
    assert.equal((await firestore('missions/mission-new', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ id: 'mission-new', title: 'New Admin Mission', points: 50 }),
    })).status, 200);

    // Regular user cannot update mission
    assert.equal((await firestore('missions/mission-new', {
      token: userAToken,
      method: 'PATCH',
      body: fields({ title: 'Hacked' }),
    })).status, 403);

    // Admin writing to receipt subcollection
    const receiptPath = `admins/${adminUid}/scoreAdjustmentRequests/req-123`;
    assert.equal((await firestore(receiptPath, {
      token: adminToken,
      method: 'PATCH',
      body: fields({ delta: 20, team: 'A' }),
    })).status, 200);

    // Non-admin writing to admin receipt
    assert.equal((await firestore(receiptPath, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ delta: 999 }),
    })).status, 403);
  });

  test('P1 Exploit: atomic mission completion transaction succeeds and rejects forged points', async () => {
    const missionId = 'mission-2';
    const completionId = `A_${CURRENT_SESSION_ID}_${missionId}`;
    const userDocName = `projects/${projectId}/databases/(default)/documents/users/${userAUid}`;
    const compDocName = `projects/${projectId}/databases/(default)/documents/missionCompletions/${completionId}`;
    const configDocName = `projects/${projectId}/databases/(default)/documents/game_config/current`;

    // 1. Forged transaction: claiming 100 points for a 30-point mission -> MUST FAIL (403)!
    const forgedWrites = [
      {
        update: {
          name: compDocName,
          fields: fields({
            gameSessionId: CURRENT_SESSION_ID,
            missionId,
            team: 'A',
            completedBy: userAUid,
            points: 100, // Forged points (mission-2 has 30 points)
            isFinalMission: false,
            completedAt: new Date(),
          }).fields,
        },
      },
      {
        update: {
          name: userDocName,
          fields: fields({
            id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'User A', status: 'ACTIVE',
            score: 100, invincibleCards: 1, lastCompletionId: completionId,
          }).fields,
        },
      },
      {
        update: {
          name: configDocName,
          fields: fields({
            gameStatus: 'DAY1_ACTIVE', gameSessionId: CURRENT_SESSION_ID, sessionStartedAt: SESSION_STARTED_AT,
            sessionSchemaVersion: 2, day: 1, missionMode: 'SEPARATE', isGameOver: false,
            teamARole: 'RUNNER', teamBRole: 'ONI', teamAScore: 200, teamBScore: 50, logs: [],
          }).fields,
        },
      },
    ];
    assert.equal((await commitBatch(forgedWrites, userAToken)).status, 403);

    // 2. Legitimate transaction: exact 30 points matching mission-2 in Firestore catalog -> MUST SUCCEED (200)!
    const legitWrites = [
      {
        update: {
          name: compDocName,
          fields: fields({
            gameSessionId: CURRENT_SESSION_ID,
            missionId,
            team: 'A',
            completedBy: userAUid,
            points: 30,
            isFinalMission: false,
            completedAt: new Date(),
          }).fields,
        },
        currentDocument: { exists: false },
      },
      {
        update: {
          name: userDocName,
          fields: fields({
            id: userAUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'Updated A', color: '#ef4444', status: 'ACTIVE',
            score: 30, invincibleCards: 0, invincibleUntil: activeUntil, lastCompletionId: completionId,
          }).fields,
        },
      },
      {
        update: {
          name: configDocName,
          fields: fields({
            gameStatus: 'DAY1_ACTIVE', gameSessionId: CURRENT_SESSION_ID, sessionStartedAt: SESSION_STARTED_AT,
            sessionSchemaVersion: 2, day: 1, missionMode: 'SEPARATE', isGameOver: false,
            teamARole: 'RUNNER', teamBRole: 'ONI', teamAScore: 150, teamBScore: 50, logs: [],
          }).fields,
        },
      },
    ];
    assert.equal((await commitBatch(legitWrites, userAToken)).status, 200);

    // 3. Replay attack: repeating the exact same completion -> MUST FAIL (403 or 409) because completion already exists!
    const replayResponse = await commitBatch(legitWrites, userAToken);
    assert.ok([403, 409].includes(replayResponse.status), `Replay status ${replayResponse.status} should be rejected`);
  });

  test('P1 Exploit: capture transaction only allowed by active ONI team with score +50 and role flip', async () => {
    // Current state: Team B is ONI, Team A is RUNNER
    // Target userCUid who is active RUNNER on Team A and NOT invincible
    await seed(`users/${userCUid}`, {
      id: userCUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', name: 'User C', role: 'RUNNER', color: '#ef4444',
      status: 'ACTIVE', score: 0, invincibleCards: 0, invincibleUntil: 0, waitingUntil: 0,
    });
    await seed(`users/${userBUid}`, {
      id: userBUid, gameSessionId: CURRENT_SESSION_ID, team: 'B', name: 'User B', role: 'RUNNER', color: '#3b82f6',
      status: 'ACTIVE', score: 0, invincibleCards: 0, invincibleUntil: 0, waitingUntil: 0,
    });
    await seed('game_config/current', {
      gameStatus: 'DAY1_ACTIVE', gameSessionId: CURRENT_SESSION_ID, sessionStartedAt: SESSION_STARTED_AT,
      sessionSchemaVersion: 2, day: 1, missionMode: 'SEPARATE', isGameOver: false,
      teamARole: 'RUNNER', teamBRole: 'ONI', teamAScore: 150, teamBScore: 50, logs: [],
    });

    const configDocName = `projects/${projectId}/databases/(default)/documents/game_config/current`;
    const targetUserDocName = `projects/${projectId}/databases/(default)/documents/users/${userCUid}`;
    const captorUserDocName = `projects/${projectId}/databases/(default)/documents/users/${userBUid}`;
    const now = Date.now();
    const waitingUntil = now + 1800000; // 30 mins

    // 1. Team A (RUNNER) attempting to perform capture -> MUST FAIL (403)!
    const runnerAttemptWrites = [
      {
        update: {
          name: configDocName,
          fields: fields({
            gameStatus: 'DAY1_ACTIVE', gameSessionId: CURRENT_SESSION_ID, sessionStartedAt: SESSION_STARTED_AT,
            sessionSchemaVersion: 2, day: 1, missionMode: 'SEPARATE', isGameOver: false,
            teamARole: 'ONI', teamBRole: 'RUNNER', teamAScore: 200, teamBScore: 50, nextRevealTime: waitingUntil,
            lastCaptureTargetId: userCUid, logs: [],
          }).fields,
        },
      },
      {
        update: {
          name: targetUserDocName,
          fields: fields({
            id: userCUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'User C', color: '#ef4444', status: 'WAITING',
            score: 0, invincibleCards: 0, waitingUntil,
          }).fields,
        },
      },
    ];
    assert.equal((await commitBatch(runnerAttemptWrites, userAToken)).status, 403);

    // 2. Exploit: ONI attempting config-only update without capturing target user doc -> MUST FAIL (403)!
    const configOnlyWrites = [
      {
        update: {
          name: configDocName,
          fields: fields({
            gameStatus: 'DAY1_ACTIVE', gameSessionId: CURRENT_SESSION_ID, sessionStartedAt: SESSION_STARTED_AT,
            sessionSchemaVersion: 2, day: 1, missionMode: 'SEPARATE', isGameOver: false,
            teamARole: 'ONI', teamBRole: 'RUNNER', teamAScore: 150, teamBScore: 100, nextRevealTime: waitingUntil,
            lastCaptureTargetId: userCUid, logs: [],
          }).fields,
        },
      },
    ];
    assert.equal((await commitBatch(configOnlyWrites, userBToken)).status, 403);

    // 3. Exploit: Same-team capture (Team B member targeting self or another Team B member) -> MUST FAIL (403)!
    const sameTeamCaptureWrites = [
      {
        update: {
          name: configDocName,
          fields: fields({
            gameStatus: 'DAY1_ACTIVE', gameSessionId: CURRENT_SESSION_ID, sessionStartedAt: SESSION_STARTED_AT,
            sessionSchemaVersion: 2, day: 1, missionMode: 'SEPARATE', isGameOver: false,
            teamARole: 'ONI', teamBRole: 'RUNNER', teamAScore: 150, teamBScore: 100, nextRevealTime: waitingUntil,
            lastCaptureTargetId: userBUid, logs: [],
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${userBUid}`,
          fields: fields({
            id: userBUid, gameSessionId: CURRENT_SESSION_ID, team: 'B', role: 'ONI', name: 'User B', color: '#3b82f6', status: 'WAITING',
            score: 50, invincibleCards: 0, waitingUntil,
          }).fields,
        },
      },
    ];
    assert.equal((await commitBatch(sameTeamCaptureWrites, userBToken)).status, 403);

    // 4. Exploit: Infinite waitingUntil (> 30 min + 60s) on captured target -> MUST FAIL (403)!
    const excessiveWaitingWrites = [
      {
        update: {
          name: configDocName,
          fields: fields({
            gameStatus: 'DAY1_ACTIVE', gameSessionId: CURRENT_SESSION_ID, sessionStartedAt: SESSION_STARTED_AT,
            sessionSchemaVersion: 2, day: 1, missionMode: 'SEPARATE', isGameOver: false,
            teamARole: 'ONI', teamBRole: 'RUNNER', teamAScore: 150, teamBScore: 100, nextRevealTime: waitingUntil,
            lastCaptureTargetId: userCUid, logs: [],
          }).fields,
        },
      },
      {
        update: {
          name: targetUserDocName,
          fields: fields({
            id: userCUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'User C', color: '#ef4444', status: 'WAITING',
            score: 0, invincibleCards: 0, waitingUntil: now + 365 * 24 * 3600 * 1000,
          }).fields,
        },
      },
    ];
    assert.equal((await commitBatch(excessiveWaitingWrites, userBToken)).status, 403);

    // 5. Legitimate cross-team capture: roles flip, ONI score +50, runner WAITING, captor ACTIVE with card +1 -> MUST SUCCEED (200)!
    const legitCaptureWrites = [
      {
        update: {
          name: configDocName,
          fields: fields({
            gameStatus: 'DAY1_ACTIVE', gameSessionId: CURRENT_SESSION_ID, sessionStartedAt: SESSION_STARTED_AT,
            sessionSchemaVersion: 2, day: 1, missionMode: 'SEPARATE', isGameOver: false,
            teamARole: 'ONI', teamBRole: 'RUNNER', teamAScore: 150, teamBScore: 100, nextRevealTime: waitingUntil,
            lastCaptureTargetId: userCUid, logs: [],
          }).fields,
        },
      },
      {
        update: {
          name: targetUserDocName,
          fields: fields({
            id: userCUid, gameSessionId: CURRENT_SESSION_ID, team: 'A', role: 'RUNNER', name: 'User C', color: '#ef4444', status: 'WAITING',
            score: 0, invincibleCards: 0, waitingUntil, invincibleUntil: 0,
          }).fields,
        },
      },
      {
        update: {
          name: captorUserDocName,
          fields: fields({
            id: userBUid, gameSessionId: CURRENT_SESSION_ID, team: 'B', role: 'RUNNER', name: 'User B', color: '#3b82f6', status: 'ACTIVE',
            score: 0, invincibleCards: 1, waitingUntil: 0, invincibleUntil: 0,
          }).fields,
        },
      },
    ];
    assert.equal((await commitBatch(legitCaptureWrites, userBToken)).status, 200);
  });
});
