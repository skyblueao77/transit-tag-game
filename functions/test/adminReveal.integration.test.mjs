import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const firestoreBase = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const functionsBase = `http://127.0.0.1:5001/${projectId}/asia-northeast1`;
let sequence = 0;

async function createAuthUser() {
  const response = await fetch(`${authBase}:signUp?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(response.ok, true, `Auth Emulator signup failed: ${response.status}`);
  return response.json();
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'number') return Number.isInteger(value)
    ? { integerValue: String(value) }
    : { doubleValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) } };
}

function decodeValue(value) {
  if (value.nullValue !== undefined) return null;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.timestampValue !== undefined) return Date.parse(value.timestampValue);
  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(decodeValue);
  if (value.mapValue !== undefined) return Object.fromEntries(
    Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, decodeValue(item)]),
  );
  return undefined;
}

async function seedDocument(path, values) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encodeValue(value)])) }),
  });
  assert.equal(response.ok, true, `Firestore seed failed for ${path}: ${response.status}`);
}

async function readDocument(path, token) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return { response };
  const document = await response.json();
  return {
    response,
    data: Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, value]) => [key, decodeValue(value)])),
  };
}

async function seedPlayer({ team = 'A', status = 'ACTIVE', location = true } = {}) {
  sequence += 1;
  const auth = await createAuthUser();
  await seedDocument(`users/${auth.localId}`, {
    id: auth.localId, name: `Reveal player ${sequence}`, team, status,
    score: 17, invincibleCards: 2, invincibleUntil: 0, waitingUntil: 0,
    shinkansenStartTime: null,
  });
  if (location) {
    await seedDocument(`privateLocations/${auth.localId}`, {
      latitude: 35.1 + sequence / 10_000,
      longitude: 139.1 + sequence / 10_000,
      updatedAt: new Date(Date.now() - 1_000),
    });
  }
  return auth;
}

async function seedAdmin() {
  const auth = await createAuthUser();
  await seedDocument(`admins/${auth.localId}`, { active: true });
  return auth;
}

async function seedConfig() {
  await seedDocument('game_config/current', { gameStatus: 'DAY1_ACTIVE', logs: [] });
}

async function call(data, token) {
  const response = await fetch(`${functionsBase}/revealPlayerLocations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  return { status: response.status, body: await response.json() };
}

function uniqueRequestId() {
  sequence += 1;
  return `123e4567-e89b-42d3-a456-${String(sequence).padStart(12, '0')}`;
}

function intent(scope, requestId = uniqueRequestId(), durationMinutes = 1) {
  return { scope, durationMinutes, requestId };
}

describe('Admin Reveal callable emulator integration', () => {
  test('Admin GLOBAL, TEAM_A, and TEAM_B create scoped snapshots and trusted deadlines', async () => {
    const admin = await seedAdmin();
    const a = await seedPlayer({ team: 'A' });
    const b = await seedPlayer({ team: 'B' });
    const emergency = await seedPlayer({ team: 'A', status: 'EMERGENCY' });
    const retired = await seedPlayer({ team: 'B', status: 'RETIRED' });
    await seedConfig();

    const global = await call(intent('GLOBAL'), admin.idToken);
    assert.equal(global.body.result.ok, true, JSON.stringify(global.body));
    assert.equal(global.body.result.projectedCount, 2);
    assert.equal(global.body.result.skippedCount, 2);
    const [globalA, globalB] = await Promise.all([
      readDocument(`exposedLocations/${a.localId}`, b.idToken),
      readDocument(`exposedLocations/${b.localId}`, a.idToken),
    ]);
    assert.equal(globalA.data.revealScope, 'GLOBAL');
    assert.equal(globalB.data.revealScope, 'GLOBAL');
    assert.equal(typeof globalA.data.capturedAt, 'number');
    assert.equal(typeof globalA.data.expiresAt, 'number');
    assert.equal((await readDocument(`exposedLocations/${emergency.localId}`, admin.idToken)).response.status, 404);
    assert.equal((await readDocument(`exposedLocations/${retired.localId}`, admin.idToken)).response.status, 404);

    const teamA = await call(intent('TEAM_A'), admin.idToken);
    assert.equal(teamA.body.result.ok, true, JSON.stringify(teamA.body));
    assert.equal((await readDocument(`exposedLocations/${a.localId}`, admin.idToken)).data.revealScope, 'TEAM_A');
    const teamB = await call(intent('TEAM_B'), admin.idToken);
    assert.equal(teamB.body.result.ok, true, JSON.stringify(teamB.body));
    assert.equal((await readDocument(`exposedLocations/${b.localId}`, admin.idToken)).data.revealScope, 'TEAM_B');
    const config = (await readDocument('game_config/current', admin.idToken)).data;
    assert.ok(config.locationRevealUntil > Date.now());
    assert.ok(config.teamARevealUntil > Date.now());
    assert.ok(config.teamBRevealUntil > Date.now());
    assert.equal(config.logs.length, 3);
    assert.equal('latitude' in global.body.result, false);
    assert.equal('longitude' in global.body.result, false);
  });

  test('rejects unauthenticated, non-Admin, malformed, and empty-valid-location requests', async () => {
    const admin = await seedAdmin();
    const player = await seedPlayer({ team: 'A', location: false });
    await seedConfig();
    assert.ok((await call(intent('GLOBAL'))).body.error);
    assert.ok((await call(intent('GLOBAL'), player.idToken)).body.error);
    assert.ok((await call({ ...intent('GLOBAL'), extra: true }, admin.idToken)).body.error);

    const list = await fetch(`${firestoreBase}/users`, { headers: { Authorization: 'Bearer owner' } });
    assert.equal(list.ok, true);
    const documents = await list.json();
    for (const document of documents.documents ?? []) {
      const team = document.fields?.team?.stringValue;
      const status = document.fields?.status?.stringValue;
      if ((team === 'A' || team === 'B') && status !== 'EMERGENCY' && status !== 'RETIRED') {
        await seedDocument(`users/${document.name.split('/').at(-1)}`, {
          ...Object.fromEntries(Object.entries(document.fields).map(([key, value]) => [key, decodeValue(value)])),
          status: 'RETIRED',
        });
      }
    }
    const empty = await call(intent('GLOBAL'), admin.idToken);
    assert.equal(empty.body.error?.details?.reason, 'ZERO_VALID_LOCATIONS');
    assert.equal((await readDocument('game_config/current', admin.idToken)).data.logs.length, 0);
  });

  test('same and concurrent request IDs replay one stable result without extra snapshots or logs', async () => {
    const admin = await seedAdmin();
    const a = await seedPlayer({ team: 'A' });
    await seedConfig();
    const request = intent('TEAM_A');
    const [first, second] = await Promise.all([
      call(request, admin.idToken), call(request, admin.idToken),
    ]);
    assert.equal(first.body.result.ok, true, JSON.stringify(first.body));
    assert.equal(second.body.result.ok, true, JSON.stringify(second.body));
    assert.deepEqual([first.body.result.duplicate, second.body.result.duplicate].sort(), [false, true]);
    assert.equal(first.body.result.expiresAt, second.body.result.expiresAt);
    assert.equal((await readDocument('game_config/current', admin.idToken)).data.logs.length, 1);
    assert.equal((await readDocument(`exposedLocations/${a.localId}`, admin.idToken)).data.revealScope, 'TEAM_A');
  });

  test('stale and missing locations are skipped while valid locations still project', async () => {
    const admin = await seedAdmin();
    const fresh = await seedPlayer({ team: 'A' });
    const missing = await seedPlayer({ team: 'A', location: false });
    const stale = await seedPlayer({ team: 'B', location: false });
    await seedDocument(`privateLocations/${stale.localId}`, {
      latitude: 35, longitude: 139, updatedAt: new Date(Date.now() - 120_000),
    });
    await seedConfig();
    const result = await call(intent('GLOBAL'), admin.idToken);
    assert.equal(result.body.result.ok, true, JSON.stringify(result.body));
    assert.ok(result.body.result.projectedCount >= 1);
    assert.equal((await readDocument(`exposedLocations/${fresh.localId}`, admin.idToken)).data.revealScope, 'GLOBAL');
    assert.equal((await readDocument(`exposedLocations/${missing.localId}`, admin.idToken)).response.status, 404);
    assert.equal((await readDocument(`exposedLocations/${stale.localId}`, admin.idToken)).response.status, 404);
  });

  test('Rules enforce audience, expiry, private-location privacy, and client-write denial', async () => {
    const admin = await seedAdmin();
    const a = await seedPlayer({ team: 'A' });
    const b = await seedPlayer({ team: 'B' });
    await seedConfig();
    const result = await call(intent('GLOBAL'), admin.idToken);
    assert.equal(result.body.result.ok, true, JSON.stringify(result.body));
    assert.equal((await readDocument(`exposedLocations/${a.localId}`, b.idToken)).response.status, 200);
    assert.equal((await readDocument(`privateLocations/${a.localId}`, b.idToken)).response.status, 403);

    const clientWrite = await fetch(`${firestoreBase}/exposedLocations/${b.localId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${b.idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        latitude: { doubleValue: 0 }, longitude: { doubleValue: 0 },
        capturedAt: { timestampValue: new Date().toISOString() },
        expiresAt: { timestampValue: new Date(Date.now() + 60_000).toISOString() },
      } }),
    });
    assert.equal(clientWrite.status, 403);

    await seedDocument(`exposedLocations/${a.localId}`, {
      playerId: a.localId, latitude: 35.1, longitude: 139.1,
      capturedAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 1),
      revealScope: 'GLOBAL',
    });
    assert.equal((await readDocument(`exposedLocations/${a.localId}`, b.idToken)).response.status, 403);
  });
});
