import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const firestoreBase = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const callableUrl = `http://127.0.0.1:5001/${projectId}/asia-northeast1/initializeGameSession`;
const cleanupPaths = new Set();

function uniqueRequestId() {
  return randomUUID();
}

async function createAuthUser() {
  const response = await fetch(`${authBase}:signUp?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(response.ok, true, `Auth emulator failed: ${response.status}`);
  return response.json();
}

function encodeFields(values) {
  return { fields: Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (typeof value === 'number') return [key, { integerValue: String(value) }];
    if (typeof value === 'boolean') return [key, { booleanValue: value }];
    if (Array.isArray(value)) return [key, { arrayValue: { values: value.map(item => ({ stringValue: item })) } }];
    return [key, { stringValue: value }];
  })) };
}

async function write(path, values) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify(encodeFields(values)),
  });
  assert.equal(response.ok, true, `Firestore seed failed at ${path}: ${response.status}`);
  if (path !== 'game_config/current') cleanupPaths.add(path);
}

async function cleanupFixtureDocuments() {
  const paths = [...cleanupPaths].reverse();
  cleanupPaths.clear();
  const batchSize = 50;
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    await Promise.all(paths.slice(offset, offset + batchSize).map(async path => {
      const response = await fetch(`${firestoreBase}/${path}`, {
        method: 'DELETE', headers: { Authorization: 'Bearer owner' },
      });
      assert.equal(response.ok, true, `Firestore cleanup failed at ${path}: ${response.status}`);
    }));
  }
}

function trackReceipt(adminUid, requestId) {
  cleanupPaths.add(`admins/${adminUid}/sessionInitializationRequests/${requestId}`);
}

async function read(path, token) {
  const response = await fetch(`${firestoreBase}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.ok, true, `Firestore read failed at ${path}: ${response.status}`);
  return response.json();
}

async function readMaybe(path, token) {
  const response = await fetch(`${firestoreBase}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  assert.equal(response.ok, true, `Firestore read failed at ${path}: ${response.status}`);
  return response.json();
}

function value(document, name) {
  const field = document.fields[name];
  if (!field) return undefined;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.stringValue !== undefined) return field.stringValue;
  return field.arrayValue?.values ?? field;
}

async function call(token, requestId) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(callableUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: { requestId } }),
  });
  return response.json();
}

async function setupLegacySession() {
  const admin = await createAuthUser();
  const playerA = `session-init-a-${randomUUID()}`;
  const playerB = `session-init-b-${randomUUID()}`;
  await write(`admins/${admin.localId}`, { role: 'admin' });
  await write(`users/${playerA}`, {
    id: playerA, team: 'A', name: 'A', status: 'WAITING', score: 17, invincibleCards: 3,
  });
  await write(`users/${playerB}`, {
    id: playerB, team: 'B', name: 'B', status: 'ACTIVE', score: 29, invincibleCards: 1,
  });
  await write('game_config/current', {
    gameStatus: 'DAY2_ACTIVE', teamAScore: 101, teamBScore: 202,
    teamARole: 'ONI', teamBRole: 'RUNNER', logs: [],
    activeMissionA: 'keep-a', activeMissionB: 'keep-b',
  });
  return { admin, playerA, playerB };
}

async function writeRosterPlayers(players) {
  const batchSize = 50;
  for (let offset = 0; offset < players.length; offset += batchSize) {
    await Promise.all(players.slice(offset, offset + batchSize).map(player => write(`users/${player.id}`, {
      id: player.id, team: player.team,
    })));
  }
}

describe('initializeGameSession callable emulator integration', () => {
  afterEach(cleanupFixtureDocuments);

  test('initializes legacy Config, backfills A/B Player Session, and replays one receipt', async () => {
    const { admin, playerA, playerB } = await setupLegacySession();
    const requestId = uniqueRequestId();
    const first = await call(admin.idToken, requestId);
    assert.equal(first.result.ok, true);
    trackReceipt(admin.localId, requestId);
    assert.equal(first.result.duplicate, false);
    assert.equal(first.result.sessionSchemaVersion, 2);
    assert.match(first.result.gameSessionId, /^[A-Za-z0-9_-]{1,128}$/);
    assert.notEqual(first.result.gameSessionId, 'legacy');

    const [config, a, b, receipt] = await Promise.all([
      read('game_config/current', admin.idToken),
      read(`users/${playerA}`, admin.idToken),
      read(`users/${playerB}`, admin.idToken),
      read(`admins/${admin.localId}/sessionInitializationRequests/${requestId}`, 'owner'),
    ]);
    assert.equal(value(config, 'gameSessionId'), first.result.gameSessionId);
    assert.equal(value(config, 'sessionStartedAt'), first.result.sessionStartedAt);
    assert.equal(value(config, 'sessionSchemaVersion'), 2);
    assert.equal(value(config, 'gameStatus'), 'DAY2_ACTIVE');
    assert.equal(value(config, 'teamAScore'), 101);
    assert.equal(value(config, 'teamBScore'), 202);
    assert.equal(value(config, 'activeMissionA'), 'keep-a');
    assert.equal(value(a, 'gameSessionId'), first.result.gameSessionId);
    assert.equal(value(b, 'gameSessionId'), first.result.gameSessionId);
    assert.equal(value(a, 'status'), 'WAITING');
    assert.equal(value(a, 'score'), 17);
    assert.equal(value(b, 'score'), 29);
    assert.equal(value(config, 'logs').length, 1);
    assert.equal(value(receipt, 'operation'), 'initializeGameSession');
    assert.equal(value(receipt, 'requestId'), requestId);
    assert.equal(value(receipt, 'gameSessionId'), first.result.gameSessionId);

    const replay = await call(admin.idToken, requestId);
    assert.equal(replay.result.gameSessionId, first.result.gameSessionId);
    assert.equal(replay.result.duplicate, true);
    const afterReplay = await read('game_config/current', admin.idToken);
    assert.equal(value(afterReplay, 'logs').length, 1);
  });

  test('rejects non-admin and refuses partially malformed legacy Config', async () => {
    const nonAdmin = await createAuthUser();
    const denied = await call(nonAdmin.idToken, uniqueRequestId());
    assert.equal(denied.error.status, 'PERMISSION_DENIED');

    const { admin } = await setupLegacySession();
    await write('game_config/current', {
      gameStatus: 'DAY2_ACTIVE', teamAScore: 101, teamBScore: 202,
      teamARole: 'ONI', teamBRole: 'RUNNER', logs: [],
      gameSessionId: 'partial-session',
    });
    const malformed = await call(admin.idToken, uniqueRequestId());
    assert.equal(malformed.error.status, 'FAILED_PRECONDITION');
    assert.equal(malformed.error.details.reason, 'INVALID_CONFIG');
    const config = await read('game_config/current', admin.idToken);
    assert.equal(value(config, 'gameSessionId'), 'partial-session');
    assert.equal(value(config, 'sessionSchemaVersion'), undefined);
  });

  test('rejects unauthenticated requests without changing seeded state', async () => {
    const { admin, playerA, playerB } = await setupLegacySession();
    const before = await Promise.all([
      read('game_config/current', admin.idToken),
      read(`users/${playerA}`, admin.idToken),
      read(`users/${playerB}`, admin.idToken),
    ]);

    const response = await call(undefined, uniqueRequestId());
    assert.equal(response.error.status, 'UNAUTHENTICATED');

    const after = await Promise.all([
      read('game_config/current', admin.idToken),
      read(`users/${playerA}`, admin.idToken),
      read(`users/${playerB}`, admin.idToken),
    ]);
    assert.deepEqual(after.map(document => document.fields), before.map(document => document.fields));
  });

  test('initializes only A/B players and excludes Admin and unknown-team users', async () => {
    const { admin, playerA, playerB } = await setupLegacySession();
    const adminProfile = `users/${admin.localId}`;
    const unknownTeamPlayer = `session-init-unknown-${randomUUID()}`;
    await write(adminProfile, { id: admin.localId, team: 'ADMIN', name: 'Admin profile' });
    await write(`users/${unknownTeamPlayer}`, { id: unknownTeamPlayer, team: 'UNKNOWN', name: 'Unknown team' });
    const adminRecordBefore = await read(`admins/${admin.localId}`, 'owner');

    const requestId = uniqueRequestId();
    const response = await call(admin.idToken, requestId);
    assert.equal(response.result.ok, true, JSON.stringify(response));
    trackReceipt(admin.localId, requestId);
    const [a, b, adminUser, unknown, adminRecordAfter] = await Promise.all([
      read(`users/${playerA}`, admin.idToken),
      read(`users/${playerB}`, admin.idToken),
      read(adminProfile, admin.idToken),
      read(`users/${unknownTeamPlayer}`, admin.idToken),
      read(`admins/${admin.localId}`, 'owner'),
    ]);
    assert.equal(value(a, 'gameSessionId'), response.result.gameSessionId);
    assert.equal(value(b, 'gameSessionId'), response.result.gameSessionId);
    assert.equal(value(adminUser, 'gameSessionId'), undefined);
    assert.equal(value(unknown, 'gameSessionId'), undefined);
    assert.equal(value(adminUser, 'team'), 'ADMIN');
    assert.equal(value(unknown, 'team'), 'UNKNOWN');
    assert.deepEqual(adminRecordAfter.fields, adminRecordBefore.fields);
  });

  test('already-initialized Config leaves Config and Players unchanged', async () => {
    const { admin, playerA, playerB } = await setupLegacySession();
    await write('game_config/current', {
      gameStatus: 'DAY2_ACTIVE', teamAScore: 101, teamBScore: 202,
      teamARole: 'ONI', teamBRole: 'RUNNER', logs: [],
      activeMissionA: 'keep-a', activeMissionB: 'keep-b',
      gameSessionId: 'existing-session', sessionStartedAt: 1_800_000_000_000,
      sessionSchemaVersion: 2,
    });
    const [configBefore, aBefore, bBefore] = await Promise.all([
      read('game_config/current', admin.idToken),
      read(`users/${playerA}`, admin.idToken),
      read(`users/${playerB}`, admin.idToken),
    ]);

    const requestId = uniqueRequestId();
    const response = await call(admin.idToken, requestId);
    if (response.result?.ok) trackReceipt(admin.localId, requestId);
    assert.deepEqual(response.result, {
      ok: true, gameSessionId: 'existing-session', sessionStartedAt: 1_800_000_000_000,
      sessionSchemaVersion: 2, duplicate: true, alreadyInitialized: true,
    });
    const [configAfter, aAfter, bAfter, receipt] = await Promise.all([
      read('game_config/current', admin.idToken),
      read(`users/${playerA}`, admin.idToken),
      read(`users/${playerB}`, admin.idToken),
      readMaybe(`admins/${admin.localId}/sessionInitializationRequests/${requestId}`, 'owner'),
    ]);
    assert.deepEqual(configAfter.fields, configBefore.fields);
    assert.deepEqual(aAfter.fields, aBefore.fields);
    assert.deepEqual(bAfter.fields, bBefore.fields);
    assert.equal(value(receipt, 'gameSessionId'), 'existing-session');
  });

  test('rejects malformed base Config without writing session state', async () => {
    const { admin, playerA, playerB } = await setupLegacySession();
    await write('game_config/current', { gameStatus: 'NOT_A_GAME_PHASE' });
    const before = await Promise.all([
      read('game_config/current', admin.idToken),
      read(`users/${playerA}`, admin.idToken),
      read(`users/${playerB}`, admin.idToken),
    ]);
    const requestId = uniqueRequestId();

    const response = await call(admin.idToken, requestId);
    assert.equal(response.error.status, 'FAILED_PRECONDITION');
    assert.equal(response.error.details.reason, 'INVALID_CONFIG');
    const after = await Promise.all([
      read('game_config/current', admin.idToken),
      read(`users/${playerA}`, admin.idToken),
      read(`users/${playerB}`, admin.idToken),
      readMaybe(`admins/${admin.localId}/sessionInitializationRequests/${requestId}`, 'owner'),
    ]);
    assert.deepEqual(after.slice(0, 3).map(document => document.fields), before.map(document => document.fields));
    assert.equal(after[3], null);
  });

  test('rejects a roster that would exceed the transaction write cap', async () => {
    const { admin, playerA } = await setupLegacySession();
    const additionalPlayers = Array.from({ length: 499 }, (_, index) => ({
      id: `session-init-cap-${index}-${randomUUID()}`,
      team: index % 2 === 0 ? 'A' : 'B',
    }));
    await writeRosterPlayers(additionalPlayers);
    const requestId = uniqueRequestId();

    const response = await call(admin.idToken, requestId);
    assert.equal(response.error.status, 'FAILED_PRECONDITION');
    assert.equal(response.error.details.reason, 'ROSTER_TOO_LARGE');
    assert.equal(await readMaybe(`admins/${admin.localId}/sessionInitializationRequests/${requestId}`, 'owner'), null);
    const [config, player] = await Promise.all([
      read('game_config/current', admin.idToken),
      read(`users/${playerA}`, admin.idToken),
    ]);
    assert.equal(value(config, 'gameSessionId'), undefined);
    assert.equal(value(player, 'gameSessionId'), undefined);
  });
});
