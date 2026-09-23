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
        typeof value === 'number' ? { integerValue: value } : { stringValue: value },
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
  adminToken = (await auth('signUp', { email: 'admin@example.test', password: 'test-password-123' })).idToken;

  await seed(`users/${userAUid}`, { id: userAUid, team: 'A', name: 'User A' });
  await seed(`users/${userBUid}`, { id: userBUid, team: 'B', name: 'User B' });
  await seed('missions/mission-1', { title: 'Test mission' });
  await seed('game_config/current', { status: 'WAITING' });

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

  test('allows a user to create and update their own valid user document', async () => {
    assert.equal((await firestore(`users/${userAUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ id: userAUid, team: 'A', name: 'Updated A' }),
    })).status, 200);
  });

  test('prevents a user from changing another user document', async () => {
    assert.equal((await firestore(`users/${userBUid}`, {
      token: userAToken,
      method: 'PATCH',
      body: fields({ id: userBUid, team: 'A', name: 'Tampered' }),
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

  test('allows an administrator to perform management writes', async () => {
    assert.equal((await firestore('game_config/current', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ status: 'RUNNING' }),
    })).status, 200);
    assert.equal((await firestore('missions/mission-1', {
      token: adminToken,
      method: 'PATCH',
      body: fields({ title: 'Updated mission' }),
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
