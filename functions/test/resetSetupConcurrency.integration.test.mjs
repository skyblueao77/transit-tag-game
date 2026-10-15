import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const documentsUrl = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const functionsUrl = `http://127.0.0.1:5001/${projectId}/asia-northeast1`;
const authUrl = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const firestoreClearUrl = `http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`;
const authClearUrl = `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/accounts`;

function encode(value) {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'number') return Number.isInteger(value)
    ? { integerValue: String(value) }
    : { doubleValue: value };
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
  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(decode);
  if (value.mapValue !== undefined) return Object.fromEntries(
    Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, decode(item)]),
  );
  return undefined;
}

function decodeFields(document) {
  return Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, value]) => [key, decode(value)]));
}

async function clearEmulatorState() {
  const firestoreResponse = await fetch(firestoreClearUrl, { method: 'DELETE' });
  assert.equal(firestoreResponse.ok, true, `Firestore clear failed: ${firestoreResponse.status}`);
  const authResponse = await fetch(authClearUrl, { method: 'DELETE' });
  assert.equal(authResponse.ok, true, `Auth clear failed: ${authResponse.status}`);
}

async function createAuthUser() {
  const response = await fetch(`${authUrl}:signUp?key=demo-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(response.ok, true, `Auth signup failed: ${response.status}`);
  return response.json();
}

async function serverWrite(path, data) {
  const response = await fetch(`${documentsUrl}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])) }),
  });
  assert.equal(response.ok, true, `Server fixture write failed at ${path}: ${response.status}`);
}

async function read(path) {
  const response = await fetch(`${documentsUrl}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (response.status === 404) return null;
  assert.equal(response.ok, true, `Read failed at ${path}: ${response.status}`);
  return decodeFields(await response.json());
}

async function clientSetup(auth, expectedSessionId) {
  const id = auth.localId;
  const entries = [
    [`users/${id}`, {
      id, name: 'Racing Setup Player', role: 'RUNNER', color: '#dc2626', team: 'A',
      score: 0, status: 'ACTIVE', gameSessionId: expectedSessionId, invincibleCards: 0,
    }],
    [`privateLocations/${id}`, {
      gameSessionId: expectedSessionId, latitude: 35.68, longitude: 139.76, updatedAt: new Date(),
    }],
  ];
  const response = await fetch(`${documentsUrl}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: entries.map(([path, data]) => ({
      update: {
        name: `projects/${projectId}/databases/(default)/documents/${path}`,
        fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])),
      },
    })) }),
  });
  return { status: response.status, body: await response.json() };
}

async function call(name, data, token) {
  const response = await fetch(`${functionsUrl}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return { status: response.status, body: await response.json() };
}

function success(response, label) {
  assert.equal(response.body.result?.ok, true, `${label}: ${JSON.stringify(response.body)}`);
  return response.body.result;
}

describe('Reset versus Setup emulator concurrency integration', () => {
  before(clearEmulatorState);

  test('Setup racing Reset is either included in the new Session or rejected atomically', async () => {
    const admin = await createAuthUser();
    await serverWrite(`admins/${admin.localId}`, { active: true });
    const playerA = `race-a-${randomUUID()}`;
    const playerB = `race-b-${randomUUID()}`;
    let sessionId = randomUUID();
    await serverWrite('game_config/current', {
      gameSessionId: sessionId,
      sessionStartedAt: Date.now(),
      sessionSchemaVersion: 2,
      gameStatus: 'GAME_OVER',
      day: 1,
      startTime: 0,
      finalMissionEndTime: 0,
      isFinalMissionActive: false,
      isGameOver: true,
      teamARole: 'ONI',
      teamBRole: 'RUNNER',
      teamAScore: 0,
      teamBScore: 0,
      missionMode: 'DIFFERENT',
      activeMissionA: null,
      activeMissionB: null,
      activeFinalMissionId: null,
      nextRevealTime: 0,
      locationRevealUntil: null,
      teamARevealUntil: null,
      teamBRevealUntil: null,
      logs: [],
    });
    for (const [id, team] of [[playerA, 'A'], [playerB, 'B']]) {
      await serverWrite(`users/${id}`, {
        id, name: `Race ${team}`, role: 'RUNNER', color: '#123456', team, gameSessionId: sessionId,
        status: 'ACTIVE', score: 0, invincibleCards: 0, invincibleUntil: 0,
        waitingUntil: 0, shinkansenStartTime: null,
      });
    }

    let acceptedSetupCount = 0;
    let deniedSetupCount = 0;
    let stalePreviewCount = 0;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const preview = success(await call('prepareGameReset', { expectedSessionId: sessionId }, admin.idToken), `Preview ${iteration + 1}`);
      const setupAuth = await createAuthUser();
      const executeRequest = {
        confirmationToken: preview.confirmationToken,
        requestId: randomUUID(),
        expectedSessionId: sessionId,
      };
      let setupPromise;
      let executePromise;
      if (iteration % 2 === 0) {
        setupPromise = clientSetup(setupAuth, sessionId);
        executePromise = call('executeGameReset', executeRequest, admin.idToken);
      } else {
        executePromise = call('executeGameReset', executeRequest, admin.idToken);
        await new Promise(resolve => setTimeout(resolve, 500));
        setupPromise = clientSetup(setupAuth, sessionId);
      }
      const [setup, execute] = await Promise.all([setupPromise, executePromise]);
      assert.ok([200, 403].includes(setup.status), `Unexpected Setup status: ${setup.status} ${JSON.stringify(setup.body)}`);
      if (setup.status === 200) acceptedSetupCount += 1;
      else deniedSetupCount += 1;

      let resetResult = execute.body.result;
      if (setup.status === 200 && execute.body.error?.details?.reason === 'CONFIRMATION_STALE') {
        stalePreviewCount += 1;
        assert.equal((await read('game_config/current')).gameSessionId, sessionId);
        const refreshedPreview = success(await call('prepareGameReset', { expectedSessionId: sessionId }, admin.idToken), `Refresh Preview ${iteration + 1}`);
        resetResult = success(await call('executeGameReset', {
          confirmationToken: refreshedPreview.confirmationToken,
          requestId: randomUUID(),
          expectedSessionId: sessionId,
        }, admin.idToken), `Refresh Reset ${iteration + 1}`);
      } else {
        resetResult = success(execute, `Concurrent Reset ${iteration + 1}`);
      }

      const nextSessionId = resetResult.newSessionId;
      assert.ok(nextSessionId && nextSessionId !== sessionId);
      assert.equal((await read('game_config/current')).gameSessionId, nextSessionId);
      const setupPlayer = await read(`users/${setupAuth.localId}`);
      const setupLocation = await read(`privateLocations/${setupAuth.localId}`);
      if (setup.status === 200) {
        assert.ok(setupPlayer, 'accepted Setup Player must be represented in the reset roster');
        assert.equal(setupPlayer.gameSessionId, nextSessionId, 'accepted Setup Player must never remain in the old Session');
        assert.equal(setupPlayer.status, 'ACTIVE');
        assert.equal(setupPlayer.score, 0);
        assert.equal(setupLocation, null, 'Reset should clean the accepted Setup location with its Player');
      } else {
        assert.equal(setupPlayer, null, 'denied Setup must not leave a Player document');
        assert.equal(setupLocation, null, 'denied Setup must not leave a private location document');
      }

      const lateOldSessionSetup = await clientSetup(await createAuthUser(), sessionId);
      assert.equal(lateOldSessionSetup.status, 403, 'old Session Setup after Reset must be rejected');
      sessionId = nextSessionId;
    }
    console.log(`Reset/Setup outcomes: accepted=${acceptedSetupCount}, denied=${deniedSetupCount}, refreshed previews=${stalePreviewCount}`);
  });
});
