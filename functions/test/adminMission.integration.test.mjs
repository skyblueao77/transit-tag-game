import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const documents = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authUrl = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const functionsUrl = `http://127.0.0.1:5001/${projectId}/asia-northeast1`;
const firestoreClearUrl = `http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`;
const authClearUrl = `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/accounts`;
const SESSION_ID = 'admin_mission_session_v1';
let sequence = 0;
async function clearEmulatorState() {
  const firestoreResponse = await fetch(firestoreClearUrl, { method: 'DELETE' });
  assert.equal(firestoreResponse.ok, true, `Firestore Emulator clear failed: ${firestoreResponse.status}`);
  const authResponse = await fetch(authClearUrl, { method: 'DELETE' });
  assert.equal(authResponse.ok, true, `Auth Emulator clear failed: ${authResponse.status}`);
}
async function createUser() {
  const response = await fetch(`${authUrl}:signUp?key=demo-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
  assert.equal(response.ok, true, `auth: ${response.status}`);
  return response.json();
}
function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, field]) => [key, encode(field)])) } };
}
function decode(value) {
  if (value.nullValue !== undefined) return null;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(decode);
  if (value.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, field]) => [key, decode(field)]));
  return undefined;
}
async function seed(path, data) {
  const response = await fetch(`${documents}/${path}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])) }) });
  assert.equal(response.ok, true, `seed ${path}: ${response.status}`);
}
async function read(path) {
  const response = await fetch(`${documents}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (!response.ok) return null;
  const body = await response.json();
  return Object.fromEntries(Object.entries(body.fields ?? {}).map(([key, value]) => [key, decode(value)]));
}
async function call(name, data, token) {
  const response = await fetch(`${functionsUrl}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) });
  return { status: response.status, body: await response.json() };
}
function requestId() {
  sequence += 1;
  return `123e4567-e89b-42d3-a456-${String(sequence).padStart(12, '0')}`;
}
async function makeAdmin() {
  const user = await createUser();
  await seed(`admins/${user.localId}`, { active: true });
  return user;
}
async function seedConfig(gameStatus = 'PRE_GAME', extra = {}) {
  await seed('game_config/current', { gameSessionId: SESSION_ID, sessionStartedAt: Date.now(), sessionSchemaVersion: 2, gameStatus, missionMode: 'DIFFERENT', activeMissionA: null, activeMissionB: null, activeFinalMissionId: null, teamAScore: 0, teamBScore: 0, logs: [], ...extra });
}

describe('trusted mission administration callable integration', () => {
  before(clearEmulatorState);

  test('syncs canonical Normal and Final catalog atomically, preserves unknown, and enables trusted Final start', async () => {
    const admin = await makeAdmin();
    const unknownId = `custom_${requestId().slice(-4)}`;
    await seed(`missions/${unknownId}`, { id: unknownId, title: 'keep me', points: 5 });
    await seed(`missions/${'m02'}`, { id: 'm02', area: 'bad', region: 'ALL', title: 'malformed', description: '', points: 'bad', type: 'PHOTO' });
    await seedConfig('DAY2_ACTIVE');
    const syncId = requestId();
    const response = await call('syncMissionCatalog', { requestId: syncId, expectedSessionId: SESSION_ID }, admin.idToken);
    assert.equal(response.body.result.ok, true, JSON.stringify(response.body));
    assert.equal(response.body.result.totalManagedCount, 36);
    assert.equal(response.body.result.updatedCount, 1);
    assert.equal((await read('missions/final_01')).id, 'final_01');
    assert.equal((await read('missions/final_04')).type, 'PHOTO');
    assert.equal((await read(`missions/${unknownId}`)).title, 'keep me');
    const config = await read('game_config/current');
    assert.equal(config.logs[0].actorUid, admin.localId);
    assert.equal(config.logs[0].action, 'syncMissionCatalog');
    assert.ok(await read(`admins/${admin.localId}/missionCatalogSyncRequests/${syncId}`));

    const phase = await call('transitionGamePhase', { action: 'START_FINAL', requestId: requestId(), expectedSessionId: SESSION_ID }, admin.idToken);
    assert.equal(phase.body.result.ok, true, JSON.stringify(phase.body));
    assert.equal(phase.body.result.newPhase, 'FINAL_MISSION');
    assert.ok((await read('game_config/current')).activeFinalMissionId);
  });

  test('supports mode changes, manual assignment, random assignment, receipts and Completion using synced canonical mission', async () => {
    const admin = await makeAdmin();
    await seedConfig('DAY1_ACTIVE');
    await call('syncMissionCatalog', { requestId: requestId(), expectedSessionId: SESSION_ID }, admin.idToken);

    const modeId = requestId();
    const mode = await call('setMissionMode', { mode: 'SAME', requestId: modeId, expectedSessionId: SESSION_ID }, admin.idToken);
    assert.equal(mode.body.result.ok, true, JSON.stringify(mode.body));
    assert.equal((await read('game_config/current')).missionMode, 'SAME');
    const repeatedMode = await call('setMissionMode', { mode: 'DIFFERENT', requestId: modeId, expectedSessionId: SESSION_ID }, admin.idToken);
    assert.equal(repeatedMode.body.result.duplicate, true);
    assert.equal((await read('game_config/current')).missionMode, 'SAME');

    const assignmentId = requestId();
    const manual = await call('assignMissions', { strategy: 'MANUAL', target: 'TEAM_A', missionId: 'm02', requestId: assignmentId, expectedSessionId: SESSION_ID }, admin.idToken);
    assert.equal(manual.body.result.ok, true, JSON.stringify(manual.body));
    assert.equal((await read('game_config/current')).activeMissionA, 'm02');
    const duplicate = await call('assignMissions', { strategy: 'MANUAL', target: 'TEAM_B', missionId: 'm03', requestId: assignmentId, expectedSessionId: SESSION_ID }, admin.idToken);
    assert.equal(duplicate.body.result.duplicate, true);
    assert.equal(duplicate.body.result.activeMissionA, 'm02');
    assert.equal((await read('game_config/current')).activeMissionB, null);

    const randomResponse = await call('assignMissions', { strategy: 'RANDOM', target: 'BOTH', requestId: requestId(), expectedSessionId: SESSION_ID }, admin.idToken);
    assert.equal(randomResponse.body.result.ok, true, JSON.stringify(randomResponse.body));
    assert.equal(randomResponse.body.result.activeMissionA, randomResponse.body.result.activeMissionB);

    await seed(`users/${admin.localId}`, { id: admin.localId, gameSessionId: SESSION_ID, name: 'Runner A', team: 'A', status: 'ACTIVE', score: 0, invincibleCards: 0 });
    const selectedId = (await read('game_config/current')).activeMissionA;
    const completion = await call('completeMission', { missionId: selectedId, expectedSessionId: SESSION_ID }, admin.idToken);
    assert.equal(completion.body.result.ok, true, JSON.stringify(completion.body));
    assert.equal(completion.body.result.missionId, selectedId);
  });

  test('rejects unauthenticated, non-admin, additional fields and invalid strategy/phase without state changes', async () => {
    const admin = await makeAdmin();
    const regular = await createUser();
    await seedConfig('PRE_GAME');
    const before = await read('game_config/current');
    const unauth = await call('setMissionMode', { mode: 'SAME', requestId: requestId(), expectedSessionId: SESSION_ID });
    assert.equal(unauth.body.error.status, 'UNAUTHENTICATED');
    const denied = await call('assignMissions', { strategy: 'RANDOM', target: 'BOTH', requestId: requestId(), expectedSessionId: SESSION_ID }, regular.idToken);
    assert.equal(denied.body.error.details.reason, 'PERMISSION_DENIED');
    for (const [data, expected] of [
      [{ mode: 'SAME', requestId: requestId(), expectedSessionId: SESSION_ID, extra: true }, 'INVALID_ARGUMENT'],
      [{ strategy: 'RANDOM', target: 'TEAM_A', requestId: requestId(), expectedSessionId: SESSION_ID }, 'INVALID_ARGUMENT'],
      [{ strategy: 'MANUAL', target: 'BOTH', missionId: 'm02', requestId: requestId(), expectedSessionId: SESSION_ID }, 'INVALID_ARGUMENT'],
      [{ strategy: 'MANUAL', target: 'TEAM_A', missionId: 'final_01', requestId: requestId(), expectedSessionId: SESSION_ID }, 'INVALID_MISSION'],
    ]) {
      const result = await call('assignMissions', data, admin.idToken);
      assert.equal(result.body.error.details.reason, expected, JSON.stringify(result.body));
    }
    assert.deepEqual(await read('game_config/current'), before);
  });

  test('stale sessions reject every mission admin action before config, catalog, or receipt writes', async () => {
    const admin = await makeAdmin();
    await seedConfig('DAY1_ACTIVE');
    await seed('missions/m02', { id: 'm02', title: 'preserve stale-session fixture', points: 5 });
    const beforeConfig = await read('game_config/current');
    const beforeMission = await read('missions/m02');
    const modeId = requestId();
    const assignmentId = requestId();
    const syncId = requestId();
    const stale = 'stale_admin_mission_session';

    const results = await Promise.all([
      call('setMissionMode', { mode: 'SAME', requestId: modeId, expectedSessionId: stale }, admin.idToken),
      call('assignMissions', { strategy: 'RANDOM', target: 'BOTH', requestId: assignmentId, expectedSessionId: stale }, admin.idToken),
      call('syncMissionCatalog', { requestId: syncId, expectedSessionId: stale }, admin.idToken),
    ]);
    for (const result of results) assert.equal(result.body.error.details.reason, 'SESSION_CHANGED');

    assert.deepEqual(await read('game_config/current'), beforeConfig);
    assert.deepEqual(await read('missions/m02'), beforeMission);
    assert.equal(await read(`admins/${admin.localId}/missionModeRequests/${modeId}`), null);
    assert.equal(await read(`admins/${admin.localId}/missionAssignmentRequests/${assignmentId}`), null);
    assert.equal(await read(`admins/${admin.localId}/missionCatalogSyncRequests/${syncId}`), null);
  });

  test('concurrent identical random request writes one assignment, log and receipt', async () => {
    const admin = await makeAdmin();
    await seedConfig('DAY1_ACTIVE', { missionMode: 'DIFFERENT' });
    await call('syncMissionCatalog', { requestId: requestId(), expectedSessionId: SESSION_ID }, admin.idToken);
    const id = requestId();
    const data = { strategy: 'RANDOM', target: 'BOTH', requestId: id, expectedSessionId: SESSION_ID };
    const [one, two] = await Promise.all([call('assignMissions', data, admin.idToken), call('assignMissions', data, admin.idToken)]);
    assert.equal(one.body.result.ok, true, JSON.stringify(one.body));
    assert.equal(two.body.result.ok, true, JSON.stringify(two.body));
    assert.equal([one.body.result.duplicate, two.body.result.duplicate].filter(Boolean).length, 1);
    const config = await read('game_config/current');
    assert.notEqual(config.activeMissionA, config.activeMissionB);
    assert.equal(config.logs.filter(log => log.action === 'assignMissions').length, 1);
    assert.ok(await read(`admins/${admin.localId}/missionAssignmentRequests/${id}`));
  });
});
