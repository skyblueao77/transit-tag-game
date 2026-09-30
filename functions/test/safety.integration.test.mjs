import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const firestoreBase = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
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

function decodeValue(value) {
  if (value.nullValue !== undefined) return null;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.stringValue !== undefined) return value.stringValue;
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
  assert.equal(response.ok, true, `Firestore read failed for ${path}: ${response.status}`);
  const document = await response.json();
  return Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, value]) => [key, decodeValue(value)]));
}

async function call(data, token) {
  const response = await fetch(`http://127.0.0.1:5001/${projectId}/asia-northeast1/requestSafetyAction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  return { status: response.status, body: await response.json() };
}

async function createPlayer({ team = 'A', status = 'ACTIVE', waitingUntil = 0, name = 'Safety Integration', invincibleCards = 3, invincibleUntil = 1_900_000_000_000 } = {}) {
  sequence += 1;
  const auth = await createAuthUser();
  await seedDocument(`users/${auth.localId}`, {
    id: auth.localId,
    name: `${name} ${sequence}`,
    team,
    status,
    waitingUntil,
    shinkansenStartTime: null,
    score: 23,
    invincibleCards,
    invincibleUntil,
  });
  await seedDocument('game_config/current', {
    gameStatus: 'GAME_OVER',
    teamARole: 'ONI',
    teamBRole: 'RUNNER',
    teamAScore: 40,
    teamBScore: 50,
    logs: [],
  });
  return auth;
}

async function assertSafetyState(auth, expectedStatus) {
  const player = await readDocument(`users/${auth.localId}`, auth.idToken);
  assert.equal(player.status, expectedStatus);
  return player;
}

function safetyLog(config) {
  return config.logs.filter(log => log.type === 'EMERGENCY');
}

describe('Safety Action callable emulator integration', () => {
  test('authenticated Emergency updates normalized fields and commits one trusted log', async () => {
    const auth = await createPlayer({ status: 'WAITING', waitingUntil: Date.now() + 60_000 });
    const result = await call({ action: 'EMERGENCY', reasonCode: 'ILLNESS_OR_INJURY' }, auth.idToken);
    assert.equal(result.body.result.ok, true);
    assert.deepEqual(result.body.result, { ok: true, changed: true, status: 'EMERGENCY' });
    const player = await assertSafetyState(auth, 'EMERGENCY');
    assert.equal(player.waitingUntil, 0);
    assert.equal(player.shinkansenStartTime, null);
    assert.equal(player.invincibleUntil, 0);
    assert.equal(player.invincibleCards, 3);
    assert.equal(player.score, 23);
    assert.equal(player.team, 'A');
    const config = await readDocument('game_config/current', auth.idToken);
    assert.equal(safetyLog(config).length, 1);
    assert.match(safetyLog(config)[0].message, /Team A Safety Integration .* が SOS を発信: 急病・怪我/);
  });

  test('authenticated Retire normalizes fields and logs; repeated Retire is a no-op', async () => {
    const auth = await createPlayer({ status: 'WAITING', waitingUntil: Date.now() + 1_000 });
    const request = { action: 'RETIRE', reasonCode: 'RETIREMENT_REQUEST' };
    const first = await call(request, auth.idToken);
    assert.deepEqual(first.body.result, { ok: true, changed: true, status: 'RETIRED' });
    const player = await assertSafetyState(auth, 'RETIRED');
    assert.equal(player.waitingUntil, 0);
    assert.equal(player.shinkansenStartTime, null);
    assert.equal(player.invincibleUntil, 0);
    assert.equal(player.invincibleCards, 3);
    const second = await call(request, auth.idToken);
    assert.deepEqual(second.body.result, { ok: true, changed: false, status: 'RETIRED' });
    assert.equal(safetyLog(await readDocument('game_config/current', auth.idToken)).length, 1);
  });

  test('rejects unauthenticated and malformed requests without changing Player state', async () => {
    const auth = await createPlayer();
    assert.equal((await call({ action: 'EMERGENCY', reasonCode: 'OTHER' }, null)).body.error.status, 'UNAUTHENTICATED');
    for (const data of [
      {}, null, [], 'bad',
      { action: 'EMERGENCY', reasonCode: 'OTHER', message: 'client text' },
      { action: 'EMERGENCY', reasonCode: 'RETIREMENT_REQUEST' },
      { action: 'RETIRE', reasonCode: 'OTHER' },
    ]) {
      assert.ok((await call(data, auth.idToken)).body.error);
    }
    const player = await assertSafetyState(auth, 'ACTIVE');
    assert.equal(player.waitingUntil, 0);
    assert.equal(safetyLog(await readDocument('game_config/current', auth.idToken)).length, 0);
  });

  test('same Emergency requests sent concurrently create only one log', async () => {
    const auth = await createPlayer();
    const request = { action: 'EMERGENCY', reasonCode: 'OTHER' };
    const results = await Promise.all([call(request, auth.idToken), call(request, auth.idToken)]);
    assert.ok(results.every(result => result.body.result?.ok === true));
    assert.equal(results.filter(result => result.body.result.changed).length, 1);
    assert.equal((await assertSafetyState(auth, 'EMERGENCY')).invincibleUntil, 0);
    assert.equal(safetyLog(await readDocument('game_config/current', auth.idToken)).length, 1);
  });

  test('Emergency can become Retired, but Retired cannot return to Emergency', async () => {
    const auth = await createPlayer();
    assert.deepEqual((await call({ action: 'EMERGENCY', reasonCode: 'OTHER' }, auth.idToken)).body.result, {
      ok: true, changed: true, status: 'EMERGENCY',
    });
    assert.deepEqual((await call({ action: 'RETIRE', reasonCode: 'RETIREMENT_REQUEST' }, auth.idToken)).body.result, {
      ok: true, changed: true, status: 'RETIRED',
    });
    const forbidden = await call({ action: 'EMERGENCY', reasonCode: 'OTHER' }, auth.idToken);
    assert.equal(forbidden.body.error.details.reason, 'RETIRED_TERMINAL');
    await assertSafetyState(auth, 'RETIRED');
    assert.equal(safetyLog(await readDocument('game_config/current', auth.idToken)).length, 2);
  });

  test('Capture preserves teammate Safety statuses while still changing the remaining roster', async () => {
    const oni = await createPlayer({ team: 'A', name: 'Captor', invincibleCards: 0, invincibleUntil: 0 });
    const runner = await createPlayer({ team: 'B', name: 'Target', invincibleCards: 0, invincibleUntil: 0 });
    const emergency = await createPlayer({ team: 'A', status: 'EMERGENCY', name: 'Emergency', invincibleCards: 0, invincibleUntil: 0 });
    const retired = await createPlayer({ team: 'B', status: 'RETIRED', name: 'Retired', invincibleCards: 0, invincibleUntil: 0 });
    await seedDocument('game_config/current', {
      gameStatus: 'DAY1_ACTIVE', teamARole: 'ONI', teamBRole: 'RUNNER',
      teamAScore: 10, teamBScore: 20, logs: [],
    });

    const response = await fetch(`http://127.0.0.1:5001/${projectId}/asia-northeast1/capturePlayer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oni.idToken}` },
      body: JSON.stringify({ data: { targetId: runner.localId } }),
    });
    const capture = await response.json();
    assert.equal(capture.result?.ok, true, JSON.stringify(capture));
    assert.deepEqual(capture.result.capture.reward, { team: 'A', scoreDelta: 50 });
    assert.deepEqual(capture.result.capture.teamRoles, { teamARole: 'RUNNER', teamBRole: 'ONI' });
    assert.equal((await readDocument(`users/${emergency.localId}`, emergency.idToken)).status, 'EMERGENCY');
    assert.equal((await readDocument(`users/${retired.localId}`, retired.idToken)).status, 'RETIRED');
    assert.equal((await readDocument(`users/${oni.localId}`, oni.idToken)).invincibleCards, 1);
    assert.equal((await readDocument(`users/${runner.localId}`, runner.idToken)).status, 'WAITING');
    const config = await readDocument('game_config/current', oni.idToken);
    assert.equal(config.teamAScore, 60);
    assert.equal(config.logs.length, 1);
    assert.equal(config.logs[0].type, 'CAPTURE');
  });
});
