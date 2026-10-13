import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const documents = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authUrl = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const functionsUrl = `http://127.0.0.1:5001/${projectId}/asia-northeast1`;
const firestoreClearUrl = `http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`;
const authClearUrl = `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/accounts`;
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const STALE_SESSION_ID = '123e4567-e89b-42d3-a456-426614174001';
let sequence = 0;

async function clearEmulatorState() {
  const firestoreResponse = await fetch(firestoreClearUrl, { method: 'DELETE' });
  assert.equal(firestoreResponse.ok, true, `Firestore clear: ${firestoreResponse.status}`);
  const authResponse = await fetch(authClearUrl, { method: 'DELETE' });
  assert.equal(authResponse.ok, true, `Auth clear: ${authResponse.status}`);
}

function encode(value) {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) } };
}

function decode(value) {
  if (value.nullValue !== undefined) return null;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.timestampValue !== undefined) return Date.parse(value.timestampValue);
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(decode);
  if (value.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, decode(item)]));
  return undefined;
}

async function seed(path, data) {
  const response = await fetch(`${documents}/${path}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])) }),
  });
  assert.equal(response.ok, true, `seed ${path}: ${response.status}`);
}

async function read(path) {
  const response = await fetch(`${documents}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (!response.ok) return null;
  const body = await response.json();
  return Object.fromEntries(Object.entries(body.fields ?? {}).map(([key, value]) => [key, decode(value)]));
}

async function createAuthUser() {
  const response = await fetch(`${authUrl}:signUp?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(response.ok, true, `signup: ${response.status}`);
  return response.json();
}

async function makeAdmin() {
  const user = await createAuthUser();
  await seed(`admins/${user.localId}`, { active: true });
  return user;
}

async function makePlayer(team, status = 'ACTIVE') {
  const user = await createAuthUser();
  await seed(`users/${user.localId}`, {
    id: user.localId, name: `private player ${team}`, team, role: 'RUNNER', status,
    gameSessionId: SESSION_ID, score: 10, invincibleCards: 2, invincibleUntil: 0, waitingUntil: 0,
  });
  return user;
}

async function call(name, data, token) {
  const response = await fetch(`${functionsUrl}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return { status: response.status, body: await response.json() };
}

function requestId() {
  sequence += 1;
  return `423e4567-e89b-42d3-a456-${String(sequence).padStart(12, '0')}`;
}

async function seedResetFixture() {
  const admin = await makeAdmin();
  const a = await makePlayer('A', 'EMERGENCY');
  const b = await makePlayer('B');
  const adminPlayer = await makePlayer('ADMIN');
  const unknown = await makePlayer('UNKNOWN');

  await seed(`privateLocations/${a.localId}`, { gameSessionId: SESSION_ID, latitude: 35.1, longitude: 139.1, updatedAt: new Date() });
  await seed(`privateLocations/${b.localId}`, { gameSessionId: SESSION_ID, latitude: 36.1, longitude: 140.1, updatedAt: new Date() });
  await seed(`privateLocations/${adminPlayer.localId}`, { gameSessionId: SESSION_ID, latitude: 37.1, longitude: 141.1, updatedAt: new Date() });
  await seed(`exposedLocations/${b.localId}`, { gameSessionId: SESSION_ID, latitude: 36.1, longitude: 140.1, expiresAt: new Date(Date.now() + 60_000) });
  await seed(`emergencyLocationProjections/${a.localId}`, {
    gameSessionId: SESSION_ID, playerId: a.localId, latitude: 35.1, longitude: 139.1, expiresAt: new Date(Date.now() + 60_000),
  });
  return { admin, a, b, adminPlayer, unknown };
}

async function seedConfig() {
  await seed('game_config/current', {
    gameSessionId: SESSION_ID, sessionStartedAt: 1_700_000_000_000, sessionSchemaVersion: 2,
    gameStatus: 'DAY1_ACTIVE', teamAScore: 9, teamBScore: 11, logs: [{ id: 'old-log' }],
  });
}

describe('trusted game reset foundation callable emulator integration', () => {
  beforeEach(clearEmulatorState);

  test('Admin Preview counts only A/B targets and persists a private, actor-bound token', async () => {
    const fixture = await seedResetFixture();
    await seedConfig();
    const response = await call('prepareGameReset', { expectedSessionId: SESSION_ID }, fixture.admin.idToken);
    assert.equal(response.body.result.ok, true, JSON.stringify(response.body));
    const preview = response.body.result;
    assert.equal(preview.participantCount, 2);
    assert.equal(preview.privateLocationCount, 2);
    assert.equal(preview.exposedLocationCount, 1);
    assert.equal(preview.emergencyProjectionCount, 1);
    assert.equal(preview.currentSessionId, SESSION_ID);
    assert.equal(preview.sessionSchemaVersion, 2);
    assert.equal(preview.resetReady, false);
    assert.equal(JSON.stringify(preview).includes('private player'), false);
    assert.equal(JSON.stringify(preview).includes('latitude'), false);
    const token = await read(`admins/${fixture.admin.localId}/resetConfirmations/${preview.confirmationToken}`);
    assert.equal(token.actorUid, fixture.admin.localId);
    assert.equal(token.used, false);
    assert.equal(token.proposedSessionId, preview.proposedSessionId);
    assert.equal(token.expiresAt - token.issuedAt, 5 * 60 * 1000);
  });

  test('rejects unauthenticated and non-admin Preview and rejects extra request fields', async () => {
    const fixture = await seedResetFixture();
    await seedConfig();
    const regular = await createAuthUser();
    assert.ok((await call('prepareGameReset', { expectedSessionId: SESSION_ID })).body.error);
    assert.equal((await call('prepareGameReset', { expectedSessionId: SESSION_ID }, regular.idToken)).body.error.details.reason, 'PERMISSION_DENIED');
    assert.equal((await call('prepareGameReset', { expectedSessionId: SESSION_ID, requestedCount: 2 }, fixture.admin.idToken)).body.error.details.reason, 'INVALID_ARGUMENT');
  });

  test('execute is server-gated and leaves Config, Players, locations, token, receipts, and logs untouched', async () => {
    const admin = await makeAdmin();
    const a = await makePlayer('A');
    const b = await makePlayer('B');
    await seedConfig();
    await seed(`privateLocations/${a.localId}`, { gameSessionId: SESSION_ID, latitude: 35.1, longitude: 139.1, updatedAt: new Date() });
    await seed(`privateLocations/${b.localId}`, { gameSessionId: SESSION_ID, latitude: 36.1, longitude: 140.1, updatedAt: new Date() });
    await seed(`exposedLocations/${b.localId}`, { gameSessionId: SESSION_ID, latitude: 36.1, longitude: 140.1, expiresAt: new Date(Date.now() + 60_000) });
    const orphanProjection = 'emergencyLocationProjections/orphan-preview-fixture';
    await seed(orphanProjection, { gameSessionId: SESSION_ID, playerId: 'orphan-preview-fixture', latitude: 35, longitude: 139 });
    const preview = (await call('prepareGameReset', { expectedSessionId: SESSION_ID }, admin.idToken)).body.result;
    const paths = [
      'game_config/current', `users/${a.localId}`, `users/${b.localId}`,
      `privateLocations/${a.localId}`, `privateLocations/${b.localId}`,
      `exposedLocations/${b.localId}`, orphanProjection,
    ];
    const before = await Promise.all(paths.map(read));
    const tokenPath = `admins/${admin.localId}/resetConfirmations/${preview.confirmationToken}`;
    const tokenBefore = await read(tokenPath);
    const executeId = requestId();
    const response = await call('executeGameReset', {
      confirmationToken: preview.confirmationToken, requestId: executeId, expectedSessionId: SESSION_ID,
    }, admin.idToken);
    assert.equal(response.body.error.details.reason, 'RESET_NOT_READY', JSON.stringify(response.body));
    assert.deepEqual(await Promise.all(paths.map(read)), before);
    assert.deepEqual(await read(tokenPath), tokenBefore);
    assert.equal(await read(`admins/${admin.localId}/gameResetRequests/${executeId}`), null);
    assert.equal((await read('game_config/current')).logs[0].id, 'old-log');

    const staleExecuteId = requestId();
    const stale = await call('executeGameReset', {
      confirmationToken: preview.confirmationToken, requestId: staleExecuteId, expectedSessionId: STALE_SESSION_ID,
    }, admin.idToken);
    assert.equal(stale.body.error.details.reason, 'SESSION_CHANGED');
    assert.deepEqual(await Promise.all(paths.map(read)), before);
    assert.deepEqual(await read(tokenPath), tokenBefore);
    assert.equal(await read(`admins/${admin.localId}/gameResetRequests/${staleExecuteId}`), null);
  });

  test('creates distinct confirmation tokens and rejects expired confirmation without writes', async () => {
    const admin = await makeAdmin();
    await seedConfig();
    const first = (await call('prepareGameReset', { expectedSessionId: SESSION_ID }, admin.idToken)).body.result;
    const second = (await call('prepareGameReset', { expectedSessionId: SESSION_ID }, admin.idToken)).body.result;
    assert.notEqual(first.confirmationToken, second.confirmationToken);
    const path = `admins/${admin.localId}/resetConfirmations/${first.confirmationToken}`;
    const expiredAt = Date.now() - 1;
    const originalToken = await read(path);
    await seed(path, { ...originalToken, expiresAt: expiredAt });
    const changedToken = await read(path);
    assert.equal(changedToken.expiresAt, expiredAt);
    assert.equal(typeof changedToken.issuedAt, 'number');
    assert.equal(typeof changedToken.used, 'boolean');
    assert.equal(typeof changedToken.previewFingerprint, 'string');
    const response = await call('executeGameReset', {
      confirmationToken: first.confirmationToken, requestId: requestId(), expectedSessionId: SESSION_ID,
    }, admin.idToken);
    assert.equal(response.body.error.details.reason, 'CONFIRMATION_EXPIRED');
    assert.equal((await read('game_config/current')).teamAScore, 9);
  });
});
