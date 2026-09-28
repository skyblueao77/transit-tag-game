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

function firestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, firestoreValue(item)])) } };
}

async function seedDocument(path, values) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, firestoreValue(value)])) }),
  });
  assert.equal(response.ok, true, `Firestore seed failed for ${path}: ${response.status}`);
}

async function readDocument(path, token) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.ok, true, `Firestore read failed for ${path}: ${response.status}`);
  return response.json();
}

function field(document, name) {
  const value = document.fields[name];
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.nullValue !== undefined) return null;
  if (value.arrayValue !== undefined) return value.arrayValue.values ?? [];
  return value;
}

async function call(name, token, data = {}) {
  const response = await fetch(`http://127.0.0.1:5001/${projectId}/asia-northeast1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  return { status: response.status, body: await response.json() };
}

async function setupPlayer({ team = 'A', roleA = 'RUNNER', roleB = 'ONI', status = 'ACTIVE', waitingUntil = 0, gameStatus = 'DAY1_ACTIVE', cards = 2 } = {}) {
  sequence += 1;
  const user = await createAuthUser();
  await seedDocument(`users/${user.localId}`, {
    id: user.localId,
    name: `Waiting Integration ${sequence}`,
    team,
    status,
    waitingUntil,
    shinkansenStartTime: null,
    score: 17,
    invincibleCards: cards,
    invincibleUntil: 0,
  });
  await seedDocument('game_config/current', {
    gameStatus,
    teamARole: roleA,
    teamBRole: roleB,
    teamAScore: 30,
    teamBScore: 40,
    logs: [],
  });
  return user;
}

function logFields(config) {
  return field(config, 'logs').map(entry => entry.mapValue.fields);
}

describe('Waiting callable emulator integration', () => {
  test('authenticated manual Waiting writes trusted deadline and SYSTEM log once', async () => {
    const user = await setupPlayer();
    const first = await call('startWaiting', user.idToken);
    assert.equal(first.body.result.ok, true);
    assert.equal(first.body.result.duration, 3_600_000);

    const [player, config] = await Promise.all([
      readDocument(`users/${user.localId}`, user.idToken),
      readDocument('game_config/current', user.idToken),
    ]);
    assert.equal(field(player, 'status'), 'WAITING');
    assert.equal(field(player, 'waitingUntil'), first.body.result.waitingUntil);
    assert.equal(field(player, 'shinkansenStartTime'), null);
    assert.equal(field(player, 'score'), 17);
    assert.equal(field(player, 'invincibleCards'), 2);
    assert.equal(field(config, 'logs').length, 1);
    assert.match(logFields(config)[0].message.stringValue, /Team A Waiting Integration .* が新幹線待機を開始 \(60分\)/);

    const repeated = await call('startWaiting', user.idToken);
    assert.ok(repeated.body.error);
    const [afterPlayer, afterConfig] = await Promise.all([
      readDocument(`users/${user.localId}`, user.idToken),
      readDocument('game_config/current', user.idToken),
    ]);
    assert.equal(field(afterPlayer, 'waitingUntil'), field(player, 'waitingUntil'));
    assert.equal(field(afterConfig, 'logs').length, 1);
  });

  test('rejects unauthenticated and non-empty requests without changing state', async () => {
    const user = await setupPlayer();
    const unauthenticated = await call('startWaiting', null);
    assert.equal(unauthenticated.body.error.status, 'UNAUTHENTICATED');
    const extra = await call('startWaiting', user.idToken, { waitingUntil: Date.now() + 10_000 });
    assert.ok(extra.body.error);
    const player = await readDocument(`users/${user.localId}`, user.idToken);
    assert.equal(field(player, 'status'), 'ACTIVE');
    assert.equal(field(player, 'waitingUntil'), 0);
  });

  test('rejects wrong role, non-ACTIVE status, and paused phase without writes', async () => {
    const wrongRole = await setupPlayer({ roleA: 'ONI' });
    const wrongRoleResult = await call('startWaiting', wrongRole.idToken);
    assert.ok(wrongRoleResult.body.error);
    assert.equal(field(await readDocument(`users/${wrongRole.localId}`, wrongRole.idToken), 'status'), 'ACTIVE');

    const waiting = await setupPlayer({ status: 'WAITING', waitingUntil: Date.now() + 60_000 });
    assert.ok((await call('startWaiting', waiting.idToken)).body.error);
    assert.equal(field(await readDocument(`users/${waiting.localId}`, waiting.idToken), 'status'), 'WAITING');

    const paused = await setupPlayer({ gameStatus: 'DAY1_PAUSED' });
    assert.ok((await call('startWaiting', paused.idToken)).body.error);
    assert.equal(field(await readDocument(`users/${paused.localId}`, paused.idToken), 'status'), 'ACTIVE');
  });

  test('resume validates deadline, normalizes fields, and safely accepts repeated calls', async () => {
    const expired = await setupPlayer({ status: 'WAITING', waitingUntil: 1 });
    const resumed = await call('resumeWaiting', expired.idToken);
    assert.deepEqual(resumed.body.result, { ok: true, resumed: true });
    const player = await readDocument(`users/${expired.localId}`, expired.idToken);
    assert.equal(field(player, 'status'), 'ACTIVE');
    assert.equal(field(player, 'waitingUntil'), 0);
    assert.equal(field(player, 'shinkansenStartTime'), null);

    const repeated = await call('resumeWaiting', expired.idToken);
    assert.deepEqual(repeated.body.result, { ok: true, resumed: false });

    const future = await setupPlayer({ status: 'WAITING', waitingUntil: Date.now() + 60_000 });
    assert.ok((await call('resumeWaiting', future.idToken)).body.error);
    assert.equal(field(await readDocument(`users/${future.localId}`, future.idToken), 'status'), 'WAITING');
  });

  test('duplicate concurrent manual starts produce at most one state and log write', async () => {
    const user = await setupPlayer();
    const results = await Promise.all([
      call('startWaiting', user.idToken),
      call('startWaiting', user.idToken),
    ]);
    assert.equal(results.filter(result => result.body.result?.ok).length, 1);
    assert.equal(results.filter(result => result.body.error).length, 1);
    const [player, config] = await Promise.all([
      readDocument(`users/${user.localId}`, user.idToken),
      readDocument('game_config/current', user.idToken),
    ]);
    assert.equal(field(player, 'status'), 'WAITING');
    assert.equal(field(config, 'logs').length, 1);
  });

  test('expired Waiting Player is rejected by Capture until trusted resume', async () => {
    const captor = await setupPlayer({ team: 'A', roleA: 'ONI', roleB: 'RUNNER' });
    const target = await setupPlayer({ team: 'B', roleA: 'ONI', roleB: 'RUNNER', status: 'WAITING', waitingUntil: Date.now() + 60_000 });
    const rejected = await call('capturePlayer', captor.idToken, { targetId: target.localId });
    assert.ok(rejected.body.error);

    await seedDocument(`users/${target.localId}`, {
      id: target.localId,
      name: `Waiting Integration ${sequence}`,
      team: 'B', status: 'WAITING', waitingUntil: 1,
      shinkansenStartTime: null, score: 17, invincibleCards: 2, invincibleUntil: 0,
    });
    assert.deepEqual((await call('resumeWaiting', target.idToken)).body.result, { ok: true, resumed: true });
    const accepted = await call('capturePlayer', captor.idToken, { targetId: target.localId });
    assert.equal(accepted.body.result.ok, true);
  });

  test('Waiting cannot activate Invincibility, while resumed ACTIVE Runner can', async () => {
    const waiting = await setupPlayer({ team: 'B', roleA: 'ONI', roleB: 'RUNNER', status: 'WAITING', waitingUntil: 1 });
    assert.ok((await call('activateInvincibility', waiting.idToken)).body.error);
    assert.deepEqual((await call('resumeWaiting', waiting.idToken)).body.result, { ok: true, resumed: true });
    const activated = await call('activateInvincibility', waiting.idToken);
    assert.equal(activated.body.result.ok, true);
  });
});
