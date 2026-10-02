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
  if (typeof value === 'number') return { integerValue: String(value) };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) } };
}

async function seedDocument(path, values) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encodeValue(value)])) }),
  });
  assert.equal(response.ok, true, `Firestore seed failed for ${path}: ${response.status}`);
}

async function seedEmergencyProjection(uid) {
  const projectedAt = new Date(Date.now()).toISOString();
  const response = await fetch(`${firestoreBase}/emergencyLocationProjections/${uid}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      playerId: { stringValue: uid },
      latitude: { doubleValue: 35.1 },
      longitude: { doubleValue: 139.1 },
      projectedAt: { timestampValue: projectedAt },
      sourceLocationUpdatedAt: { timestampValue: projectedAt },
      expiresAt: { timestampValue: new Date(Date.now() + 120_000).toISOString() },
      safetyStatus: { stringValue: 'EMERGENCY' },
      projectionKind: { stringValue: 'EMERGENCY' },
    } }),
  });
  assert.equal(response.ok, true, `Projection seed failed: ${response.status}`);
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

async function readDocument(path, token) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.ok, true, `Firestore read failed for ${path}: ${response.status}`);
  const document = await response.json();
  return Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, value]) => [key, decodeValue(value)]));
}

async function seedPlayer({ team = 'A', status = 'ACTIVE', name } = {}) {
  sequence += 1;
  const auth = await createAuthUser();
  await seedDocument(`users/${auth.localId}`, {
    id: auth.localId,
    name: name ?? `Admin integration ${sequence}`,
    team,
    status,
    waitingUntil: status === 'WAITING' ? Date.now() + 90_000 : 0,
    shinkansenStartTime: null,
    invincibleUntil: 1_900_000_000_000,
    invincibleCards: 4,
    score: 37,
    role: team === 'A' ? 'ONI' : 'RUNNER',
    color: '#123456',
  });
  return auth;
}

async function seedAdmin() {
  const auth = await createAuthUser();
  await seedDocument(`admins/${auth.localId}`, { active: true });
  return auth;
}

async function seedConfig({ teamARole = 'ONI', teamBRole = 'RUNNER', logs = [] } = {}) {
  await seedDocument('game_config/current', {
    teamARole,
    teamBRole,
    nextRevealTime: 0,
    gameStatus: 'GAME_OVER',
    teamAScore: 51,
    teamBScore: 62,
    logs,
  });
}

async function call(name, data, token) {
  const response = await fetch(`${functionsBase}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  return { status: response.status, body: await response.json() };
}

async function readProjectionResponse(uid, token) {
  return fetch(`${firestoreBase}/emergencyLocationProjections/${uid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function uniqueRequestId() {
  sequence += 1;
  return `123e4567-e89b-42d3-a456-${String(sequence).padStart(12, '0')}`;
}

describe('Admin Game State callable emulator integration', () => {
  test('Admin Role Swap commits config, full roster, safety preservation, and one log atomically', async () => {
    const admin = await seedAdmin();
    const a = await seedPlayer({ team: 'A', status: 'ACTIVE' });
    const b = await seedPlayer({ team: 'B', status: 'WAITING' });
    const emergency = await seedPlayer({ team: 'A', status: 'EMERGENCY' });
    const retired = await seedPlayer({ team: 'B', status: 'RETIRED' });
    await seedConfig();

    const result = await call('swapTeamRoles', { requestId: uniqueRequestId() }, admin.idToken);
    assert.equal(result.body.result.ok, true);
    assert.equal(result.body.result.newOniTeam, 'B');
    const [config, aPlayer, bPlayer, emergencyPlayer, retiredPlayer] = await Promise.all([
      readDocument('game_config/current', admin.idToken),
      readDocument(`users/${a.localId}`, admin.idToken),
      readDocument(`users/${b.localId}`, admin.idToken),
      readDocument(`users/${emergency.localId}`, admin.idToken),
      readDocument(`users/${retired.localId}`, admin.idToken),
    ]);
    assert.equal(config.teamARole, 'RUNNER');
    assert.equal(config.teamBRole, 'ONI');
    assert.equal(config.nextRevealTime, result.body.result.nextRevealTime);
    assert.equal(config.logs.length, 1);
    assert.equal(aPlayer.status, 'ACTIVE');
    assert.equal(aPlayer.waitingUntil, 0);
    assert.equal(aPlayer.shinkansenStartTime, null);
    assert.equal(bPlayer.status, 'WAITING');
    assert.equal(bPlayer.waitingUntil, result.body.result.nextRevealTime);
    assert.equal(bPlayer.shinkansenStartTime, null);
    assert.equal(bPlayer.invincibleUntil, 0);
    assert.equal(emergencyPlayer.status, 'EMERGENCY');
    assert.equal(retiredPlayer.status, 'RETIRED');
    assert.equal(aPlayer.invincibleCards, 4);
    assert.equal(aPlayer.score, 37);
    assert.equal(config.teamAScore, 51);
    assert.equal(config.teamBScore, 62);
  });

  test('rejects unauthenticated, non-Admin, and malformed requests without changing config', async () => {
    const admin = await seedAdmin();
    const player = await seedPlayer({ team: 'A', status: 'ACTIVE' });
    await seedConfig();
    const before = await readDocument('game_config/current', admin.idToken);

    assert.ok((await call('swapTeamRoles', { requestId: uniqueRequestId() })).body.error);
    const nonAdmin = await createAuthUser();
    assert.ok((await call('swapTeamRoles', { requestId: uniqueRequestId() }, nonAdmin.idToken)).body.error);
    assert.ok((await call('swapTeamRoles', { requestId: uniqueRequestId(), team: 'A' }, admin.idToken)).body.error);
    const after = await readDocument('game_config/current', admin.idToken);
    assert.equal(after.teamARole, before.teamARole);
    assert.equal(after.teamBRole, before.teamBRole);
    assert.equal(after.logs.length, before.logs.length);
    assert.equal((await readDocument(`users/${player.localId}`, admin.idToken)).status, 'ACTIVE');
  });

  test('concurrent distinct Role Swap requests serialize to a consistent final roster', async () => {
    const admin = await seedAdmin();
    const a = await seedPlayer({ team: 'A', status: 'ACTIVE' });
    const b = await seedPlayer({ team: 'B', status: 'ACTIVE' });
    const emergency = await seedPlayer({ team: 'A', status: 'EMERGENCY' });
    await seedConfig();

    const [first, second] = await Promise.all([
      call('swapTeamRoles', { requestId: uniqueRequestId() }, admin.idToken),
      call('swapTeamRoles', { requestId: uniqueRequestId() }, admin.idToken),
    ]);
    assert.equal(first.body.result.ok, true, JSON.stringify(first.body));
    assert.equal(second.body.result.ok, true, JSON.stringify(second.body));
    const [config, aPlayer, bPlayer, emergencyPlayer] = await Promise.all([
      readDocument('game_config/current', admin.idToken),
      readDocument(`users/${a.localId}`, admin.idToken),
      readDocument(`users/${b.localId}`, admin.idToken),
      readDocument(`users/${emergency.localId}`, admin.idToken),
    ]);
    assert.equal(config.teamARole, 'ONI');
    assert.equal(config.teamBRole, 'RUNNER');
    assert.equal(aPlayer.status, 'WAITING');
    assert.equal(bPlayer.status, 'ACTIVE');
    assert.equal(emergencyPlayer.status, 'EMERGENCY');
    assert.equal(config.logs.length, 2);
  });

  test('concurrent duplicate Role Swap request IDs commit exactly one reversal and audit log', async () => {
    const admin = await seedAdmin();
    const a = await seedPlayer({ team: 'A', status: 'ACTIVE' });
    const b = await seedPlayer({ team: 'B', status: 'ACTIVE' });
    await seedConfig();
    const request = { requestId: uniqueRequestId() };

    const [first, second] = await Promise.all([
      call('swapTeamRoles', request, admin.idToken),
      call('swapTeamRoles', request, admin.idToken),
    ]);
    assert.equal(first.body.result.ok, true, JSON.stringify(first.body));
    assert.equal(second.body.result.ok, true, JSON.stringify(second.body));
    assert.equal(first.body.result.teamARole, second.body.result.teamARole);
    assert.equal(first.body.result.teamBRole, second.body.result.teamBRole);
    assert.deepEqual([first.body.result.replayed, second.body.result.replayed].sort(), [false, true]);
    const [config, aPlayer, bPlayer] = await Promise.all([
      readDocument('game_config/current', admin.idToken),
      readDocument(`users/${a.localId}`, admin.idToken),
      readDocument(`users/${b.localId}`, admin.idToken),
    ]);
    assert.equal(config.teamARole, 'RUNNER');
    assert.equal(config.teamBRole, 'ONI');
    assert.equal(config.logs.length, 1);
    assert.equal(aPlayer.status, 'ACTIVE');
    assert.equal(bPlayer.status, 'WAITING');
  });

  test('Admin Resume handles WAITING and is idempotent for ACTIVE', async () => {
    const admin = await seedAdmin();
    const waiting = await seedPlayer({ team: 'A', status: 'WAITING' });
    const active = await seedPlayer({ team: 'B', status: 'ACTIVE' });
    await seedConfig();

    const resumed = await call('resumePlayer', { targetId: waiting.localId }, admin.idToken);
    assert.deepEqual(resumed.body.result, { ok: true, resumed: true, status: 'ACTIVE' });
    const waitingPlayer = await readDocument(`users/${waiting.localId}`, admin.idToken);
    assert.equal(waitingPlayer.status, 'ACTIVE');
    assert.equal(waitingPlayer.waitingUntil, 0);
    assert.equal(waitingPlayer.shinkansenStartTime, null);
    const configAfterResume = await readDocument('game_config/current', admin.idToken);
    assert.equal(configAfterResume.logs.length, 1);

    const noOp = await call('resumePlayer', { targetId: active.localId }, admin.idToken);
    assert.deepEqual(noOp.body.result, { ok: true, resumed: false, status: 'ACTIVE' });
    assert.equal((await readDocument('game_config/current', admin.idToken)).logs.length, 1);
  });

  test('Admin Resume clears Emergency status while its Projection becomes inaccessible', async () => {
    const admin = await seedAdmin();
    const emergency = await seedPlayer({ team: 'A', status: 'EMERGENCY' });
    await seedConfig();
    await seedEmergencyProjection(emergency.localId);

    const result = await call('resumePlayer', { targetId: emergency.localId }, admin.idToken);
    assert.deepEqual(result.body.result, { ok: true, resumed: true, status: 'ACTIVE' });
    const player = await readDocument(`users/${emergency.localId}`, admin.idToken);
    assert.equal(player.status, 'ACTIVE');
    assert.equal(player.invincibleUntil, 0);
    let response;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      response = await readProjectionResponse(emergency.localId, admin.idToken);
      if (!response.ok) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(response && !response.ok, 'projection remains inaccessible after Emergency is cleared');
  });

  test('Admin Resume permits explicit Retired override and retains score/team/cards', async () => {
    const admin = await seedAdmin();
    const retired = await seedPlayer({ team: 'B', status: 'RETIRED' });
    await seedConfig();
    const result = await call('resumePlayer', { targetId: retired.localId }, admin.idToken);
    assert.deepEqual(result.body.result, { ok: true, resumed: true, status: 'ACTIVE' });
    const player = await readDocument(`users/${retired.localId}`, admin.idToken);
    assert.equal(player.status, 'ACTIVE');
    assert.equal(player.waitingUntil, 0);
    assert.equal(player.shinkansenStartTime, null);
    assert.equal(player.invincibleUntil, 0);
    assert.equal(player.team, 'B');
    assert.equal(player.score, 37);
    assert.equal(player.invincibleCards, 4);
    assert.equal((await readDocument('game_config/current', admin.idToken)).logs.length, 1);
  });
});
