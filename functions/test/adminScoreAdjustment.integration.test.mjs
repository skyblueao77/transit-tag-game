import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const documents = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authUrl = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const functionsUrl = `http://127.0.0.1:5001/${projectId}/asia-northeast1`;
const firestoreClearUrl = `http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`;
const authClearUrl = `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/accounts`;
const SESSION_ID = 'score-adjustment-session';
const STALE_SESSION_ID = 'previous-score-adjustment-session';
let sequence = 0;

async function clearEmulatorState() {
  const firestoreResponse = await fetch(firestoreClearUrl, { method: 'DELETE' });
  assert.equal(firestoreResponse.ok, true, `Firestore Emulator clear failed: ${firestoreResponse.status}`);
  const authResponse = await fetch(authClearUrl, { method: 'DELETE' });
  assert.equal(authResponse.ok, true, `Auth Emulator clear failed: ${authResponse.status}`);
}
async function createUser() {
  const response = await fetch(`${authUrl}:signUp?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(response.ok, true, `Auth Emulator signup failed: ${response.status}`);
  return response.json();
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
async function call(name, data, token) {
  const response = await fetch(`${functionsUrl}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return { status: response.status, body: await response.json() };
}
function requestId() {
  sequence += 1;
  return `123e4567-e89b-42d3-a456-${String(sequence).padStart(12, '0')}`;
}
async function createAdmin() {
  const user = await createUser();
  await seed(`admins/${user.localId}`, { active: true });
  return user;
}
async function seedConfig(extra = {}) {
  await seed('game_config/current', {
    teamAScore: 20, teamBScore: 30, logs: [], gameStatus: 'DAY1_ACTIVE',
    gameSessionId: SESSION_ID, sessionStartedAt: 1_700_000_000_000, sessionSchemaVersion: 2,
    missionMode: 'DIFFERENT', activeMissionA: null, activeMissionB: null,
    teamARole: 'RUNNER', teamBRole: 'ONI', untouched: 'preserve', ...extra,
  });
}
function adjustment(team, delta, reasonCode = 'CORRECTION', id = requestId(), expectedSessionId = SESSION_ID) {
  return { team, delta, reasonCode, requestId: id, expectedSessionId };
}

describe('trusted Team score adjustment callable integration', () => {
  before(clearEmulatorState);

  test('Admin applies positive Team A and negative Team B deltas with atomic audit receipts', async () => {
    const admin = await createAdmin();
    await seedConfig();
    const a = await call('adjustTeamScore', adjustment('A', 7, 'BONUS'), admin.idToken);
    assert.equal(a.body.result.ok, true, JSON.stringify(a.body));
    assert.deepEqual([a.body.result.previousScore, a.body.result.nextScore], [20, 27]);
    const bRequest = adjustment('B', -10, 'PENALTY');
    const b = await call('adjustTeamScore', bRequest, admin.idToken);
    assert.equal(b.body.result.ok, true, JSON.stringify(b.body));
    assert.deepEqual([b.body.result.previousScore, b.body.result.nextScore], [30, 20]);
    const config = await read('game_config/current');
    assert.equal(config.teamAScore, 27);
    assert.equal(config.teamBScore, 20);
    assert.equal(config.untouched, 'preserve');
    assert.equal(config.logs.filter(log => log.action === 'adjustTeamScore').length, 2);
    assert.equal(config.logs[0].actorUid, admin.localId);
    assert.equal(config.logs[0].reasonCode, 'PENALTY');
    assert.ok(await read(`admins/${admin.localId}/scoreAdjustmentRequests/${bRequest.requestId}`));
  });

  test('allows exact zero and rejects a negative resulting score without writes', async () => {
    const admin = await createAdmin();
    await seedConfig({ teamAScore: 5 });
    const zero = await call('adjustTeamScore', adjustment('A', -5), admin.idToken);
    assert.equal(zero.body.result.nextScore, 0);
    const before = await read('game_config/current');
    const denied = await call('adjustTeamScore', adjustment('A', -1), admin.idToken);
    assert.equal(denied.body.error.details.reason, 'SCORE_BELOW_ZERO');
    assert.equal((await read('game_config/current')).teamAScore, before.teamAScore);
    assert.equal((await read('game_config/current')).logs.length, before.logs.length);
  });

  test('requires Admin authentication, strict request fields, and rejects reused IDs with changed payload', async () => {
    const admin = await createAdmin();
    const regular = await createUser();
    await seedConfig();
    const before = await read('game_config/current');
    assert.equal((await call('adjustTeamScore', adjustment('A', 1))).body.error.status, 'UNAUTHENTICATED');
    const denied = await call('adjustTeamScore', adjustment('A', 1), regular.idToken);
    assert.equal(denied.body.error.details.reason, 'PERMISSION_DENIED');
    const extra = await call('adjustTeamScore', { ...adjustment('A', 1), nextScore: 999 }, admin.idToken);
    assert.equal(extra.body.error.details.reason, 'INVALID_ARGUMENT');
    const id = requestId();
    assert.equal((await call('adjustTeamScore', adjustment('A', 2, 'CORRECTION', id), admin.idToken)).body.result.ok, true);
    const reused = await call('adjustTeamScore', adjustment('B', 2, 'CORRECTION', id), admin.idToken);
    assert.equal(reused.body.error.details.reason, 'REQUEST_ID_REUSED');
    const config = await read('game_config/current');
    assert.equal(config.teamAScore, before.teamAScore + 2);
    assert.equal(config.teamBScore, before.teamBScore);
  });

  test('same and different request IDs behave idempotently under concurrent requests', async () => {
    const admin = await createAdmin();
    await seedConfig({ teamAScore: 0 });
    const same = adjustment('A', 5);
    const [sameOne, sameTwo] = await Promise.all([
      call('adjustTeamScore', same, admin.idToken),
      call('adjustTeamScore', same, admin.idToken),
    ]);
    assert.equal(sameOne.body.result.ok, true, JSON.stringify(sameOne.body));
    assert.equal(sameTwo.body.result.ok, true, JSON.stringify(sameTwo.body));
    assert.equal([sameOne.body.result.duplicate, sameTwo.body.result.duplicate].filter(Boolean).length, 1);
    const [one, two] = await Promise.all([
      call('adjustTeamScore', adjustment('A', 7), admin.idToken),
      call('adjustTeamScore', adjustment('A', 11), admin.idToken),
    ]);
    assert.equal(one.body.result.ok, true, JSON.stringify(one.body));
    assert.equal(two.body.result.ok, true, JSON.stringify(two.body));
    const config = await read('game_config/current');
    assert.equal(config.teamAScore, 23);
    assert.equal(config.logs.filter(log => log.action === 'adjustTeamScore').length, 3);
  });

  test('stale Session adjustment is denied before Config or receipt writes', async () => {
    const admin = await createAdmin();
    await seedConfig();
    const request = adjustment('A', 6);
    const before = await read('game_config/current');

    const denied = await call('adjustTeamScore', { ...request, expectedSessionId: STALE_SESSION_ID }, admin.idToken);

    assert.equal(denied.body.error.details.reason, 'SESSION_CHANGED');
    assert.deepEqual(await read('game_config/current'), before);
    assert.equal(await read(`admins/${admin.localId}/scoreAdjustmentRequests/${request.requestId}`), null);
  });

  test('adjustment after Mission Completion uses the latest Config score and preserves Player score', async () => {
    const player = await createUser();
    const admin = await createAdmin();
    await seed(`users/${player.localId}`, {
      id: player.localId, name: 'Runner', team: 'A', status: 'ACTIVE', score: 3,
      invincibleCards: 0, gameSessionId: SESSION_ID,
    });
    await seed('missions/m01', { id: 'm01', points: 10, type: 'CHECKIN', title: 'Mission' });
    await seedConfig({ gameStatus: 'DAY1_ACTIVE', activeMissionA: 'm01', teamAScore: 0 });
    const completion = await call('completeMission', { missionId: 'm01', expectedSessionId: SESSION_ID }, player.idToken);
    assert.equal(completion.body.result.ok, true, JSON.stringify(completion.body));
    const beforeAdjustment = await read('game_config/current');
    const playerBefore = await read(`users/${player.localId}`);
    const result = await call('adjustTeamScore', adjustment('A', 4, 'OTHER'), admin.idToken);
    assert.equal(result.body.result.previousScore, beforeAdjustment.teamAScore);
    assert.equal(result.body.result.nextScore, beforeAdjustment.teamAScore + 4);
    assert.equal((await read('game_config/current')).teamAScore, beforeAdjustment.teamAScore + 4);
    assert.equal((await read(`users/${player.localId}`)).score, playerBefore.score);
  });
});
