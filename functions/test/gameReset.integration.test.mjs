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
    assert.equal(preview.resetReady, true);
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

  test('executes one atomic Session reset, keeps Completion history, and stably replays its receipt', async () => {
    const admin = await makeAdmin();
    const a = await makePlayer('A', 'CAPTURED');
    const b = await makePlayer('B', 'CAPTURED');
    const adminPlayer = await makePlayer('ADMIN');
    const unknownPlayer = await makePlayer('UNKNOWN');
    await seedConfig();
    await seed(`users/${a.localId}`, {
      ...await read(`users/${a.localId}`), waitingUntil: 123, invincibleUntil: 456, invincibleCards: 4, shinkansenStartTime: new Date(0),
    });
    await seed(`users/${b.localId}`, {
      ...await read(`users/${b.localId}`), waitingUntil: 789, invincibleUntil: 999, invincibleCards: 3, shinkansenStartTime: new Date(1),
    });
    await seed(`privateLocations/${a.localId}`, { gameSessionId: SESSION_ID, latitude: 35.1, longitude: 139.1, updatedAt: new Date() });
    await seed(`privateLocations/${b.localId}`, { gameSessionId: SESSION_ID, latitude: 36.1, longitude: 140.1, updatedAt: new Date() });
    await seed(`privateLocations/${adminPlayer.localId}`, { gameSessionId: SESSION_ID, latitude: 37.1, longitude: 141.1, updatedAt: new Date() });
    await seed(`privateLocations/${unknownPlayer.localId}`, { gameSessionId: SESSION_ID, latitude: 38.1, longitude: 142.1, updatedAt: new Date() });
    await seed(`exposedLocations/${b.localId}`, { gameSessionId: SESSION_ID, latitude: 36.1, longitude: 140.1, expiresAt: new Date(Date.now() + 60_000) });

    const orphanProjection = 'emergencyLocationProjections/orphan-preview-fixture';
    await seed(orphanProjection, { gameSessionId: SESSION_ID, playerId: 'orphan-preview-fixture', latitude: 35, longitude: 139 });
    const completionPath = 'missionCompletions/legacy-history-fixture';
    await seed(completionPath, { missionId: 'old-mission', team: 'A', completedBy: a.localId, points: 10 });

    const previewResponse = await call('prepareGameReset', { expectedSessionId: SESSION_ID }, admin.idToken);
    assert.equal(previewResponse.body.result.resetReady, true);
    const preview = previewResponse.body.result;
    const paths = [
      'game_config/current', `users/${a.localId}`, `users/${b.localId}`,
      `users/${adminPlayer.localId}`, `users/${unknownPlayer.localId}`,
      `privateLocations/${a.localId}`, `privateLocations/${b.localId}`,
      `privateLocations/${adminPlayer.localId}`, `privateLocations/${unknownPlayer.localId}`,
      `exposedLocations/${b.localId}`, `emergencyLocationProjections/${a.localId}`,
      orphanProjection, completionPath,
    ];
    const tokenPath = `admins/${admin.localId}/resetConfirmations/${preview.confirmationToken}`;
    const tokenBefore = await read(tokenPath);
    const executeId = requestId();
    const executeInput = {
      confirmationToken: preview.confirmationToken, requestId: executeId, expectedSessionId: SESSION_ID,
    };
    const response = await call('executeGameReset', executeInput, admin.idToken);
    assert.equal(response.body.result?.ok, true, JSON.stringify(response.body));
    assert.equal(response.body.result.executed, true);
    assert.equal(response.body.result.newSessionId, preview.proposedSessionId);

    const after = await Promise.all(paths.map(read));
    const resetConfig = after[0];
    assert.equal(resetConfig.gameSessionId, preview.proposedSessionId);
    assert.equal(resetConfig.sessionStartedAt, resetConfig.logs[0].timestamp);
    assert.equal(resetConfig.sessionSchemaVersion, 2);
    assert.equal(resetConfig.gameStatus, 'PRE_GAME');
    assert.equal(resetConfig.day, 1);
    assert.equal(resetConfig.teamAScore, 0);
    assert.equal(resetConfig.teamBScore, 0);
    assert.equal(resetConfig.teamARole, 'RUNNER');
    assert.equal(resetConfig.teamBRole, 'ONI');
    assert.equal(resetConfig.activeMissionA, null);
    assert.equal(resetConfig.activeMissionB, null);
    assert.equal(resetConfig.activeFinalMissionId, null);
    assert.equal(resetConfig.locationRevealUntil, null);
    assert.equal(resetConfig.logs[0].action, 'executeGameReset');
    assert.equal(resetConfig.logs[0].actorUid, admin.localId);
    assert.equal(resetConfig.logs[1].id, 'old-log');

    for (const player of [after[1], after[2]]) {
      assert.equal(player.gameSessionId, preview.proposedSessionId);
      assert.equal(player.status, 'ACTIVE');
      assert.equal(player.score, 0);
      assert.equal(player.invincibleCards, 0);
      assert.equal(player.invincibleUntil, 0);
      assert.equal(player.waitingUntil, 0);
      assert.equal(player.shinkansenStartTime, null);
    }
    assert.equal(after[3].score, 10);
    assert.equal(after[4].score, 10);
    assert.equal(after[5], null);
    assert.equal(after[6], null);
    assert.ok(after[7]);
    assert.ok(after[8]);
    assert.equal(after[9], null);
    assert.equal(after[10], null);
    assert.ok(after[11]);
    assert.deepEqual(after[12], { missionId: 'old-mission', team: 'A', completedBy: a.localId, points: 10 });

    const tokenAfter = await read(tokenPath);
    assert.equal(tokenAfter.used, true);
    assert.ok(tokenAfter.usedAt >= tokenBefore.issuedAt);
    const receiptPath = `admins/${admin.localId}/gameResetRequests/${executeId}`;
    const receipt = await read(receiptPath);
    assert.equal(receipt.gameSessionId, SESSION_ID);
    assert.equal(receipt.confirmationToken, preview.confirmationToken);
    assert.deepEqual(receipt.result, response.body.result);

    const replay = await call('executeGameReset', executeInput, admin.idToken);
    assert.deepEqual(replay.body.result, response.body.result);
    assert.deepEqual(await Promise.all(paths.map(read)), after);
    assert.deepEqual(await read(tokenPath), tokenAfter);
    assert.deepEqual(await read(receiptPath), receipt);

    const staleInput = { ...executeInput, requestId: requestId() };
    const stale = await call('executeGameReset', staleInput, admin.idToken);
    assert.equal(stale.body.error.details.reason, 'SESSION_CHANGED');
    assert.deepEqual(await Promise.all(paths.map(read)), after);
    assert.deepEqual(await read(tokenPath), tokenAfter);
  });

  test('rejects old-client Execute shape and stale Session without changing authoritative state', async () => {
    const admin = await makeAdmin();
    await seedConfig();
    const a = await makePlayer('A');
    const preview = (await call('prepareGameReset', { expectedSessionId: SESSION_ID }, admin.idToken)).body.result;
    const before = await Promise.all(['game_config/current', `users/${a.localId}`].map(read));
    const tokenPath = `admins/${admin.localId}/resetConfirmations/${preview.confirmationToken}`;
    const tokenBefore = await read(tokenPath);

    const oldClient = await call('executeGameReset', {
      confirmationToken: preview.confirmationToken, requestId: requestId(),
    }, admin.idToken);
    assert.equal(oldClient.body.error.details.reason, 'INVALID_ARGUMENT');
    const stale = await call('executeGameReset', {
      confirmationToken: preview.confirmationToken, requestId: requestId(), expectedSessionId: STALE_SESSION_ID,
    }, admin.idToken);
    assert.equal(stale.body.error.details.reason, 'SESSION_CHANGED');
    assert.deepEqual(await Promise.all(['game_config/current', `users/${a.localId}`].map(read)), before);
    assert.deepEqual(await read(tokenPath), tokenBefore);
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
