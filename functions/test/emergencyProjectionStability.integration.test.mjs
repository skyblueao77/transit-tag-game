import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const documentsUrl = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authUrl = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const firestoreClearUrl = `http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`;
const authClearUrl = `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/accounts`;
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const projectionHarnessTimeoutMs = 30_000;
const pollIntervalMs = 100;
const iterations = 20;
const heartbeatsPerPlayer = 3;

function encode(value) {
  if (value === null) return { nullValue: null };
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

function decodeDocument(document) {
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(response.ok, true, `Auth signup failed: ${response.status}`);
  return response.json();
}

async function writeServer(path, values) {
  const response = await fetch(`${documentsUrl}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encode(value)])) }),
  });
  assert.equal(response.ok, true, `Server write failed for ${path}: ${response.status} ${await response.text()}`);
}

async function readDocumentSnapshot(path) {
  const response = await fetch(`${documentsUrl}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (response.status === 404) return null;
  assert.equal(response.ok, true, `Firestore read failed for ${path}: ${response.status}`);
  const document = await response.json();
  return { data: decodeDocument(document), updateTime: document.updateTime };
}

async function readDocument(path) {
  return (await readDocumentSnapshot(path))?.data ?? null;
}

async function writePrivateLocation(auth, updatedAt) {
  const response = await fetch(`${documentsUrl}/privateLocations/${auth.localId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${auth.idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      gameSessionId: { stringValue: sessionId },
      latitude: { doubleValue: 35.1 },
      longitude: { doubleValue: 139.1 },
      updatedAt: { timestampValue: new Date(updatedAt).toISOString() },
    } }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, `Owner location write failed for ${auth.localId}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitForProjection(uid, expectedSourceUpdatedAt) {
  const startedAt = Date.now();
  const deadline = startedAt + projectionHarnessTimeoutMs;
  let lastProjection = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const snapshot = await readDocumentSnapshot(`emergencyLocationProjections/${uid}`);
    lastProjection = snapshot?.data ?? null;
    if (Date.now() <= deadline
      && lastProjection?.gameSessionId === sessionId
      && lastProjection?.playerId === uid
      && lastProjection?.safetyStatus === 'EMERGENCY'
      && lastProjection?.projectionKind === 'EMERGENCY'
      && lastProjection?.sourceLocationUpdatedAt === expectedSourceUpdatedAt) {
      return {
        projection: lastProjection,
        updateTime: snapshot.updateTime,
        elapsedMs: Date.now() - startedAt,
        attempts,
      };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }
  const pollingEndedAt = Date.now();
  const [config, player, location] = await Promise.all([
    readDocument('game_config/current'),
    readDocument(`users/${uid}`),
    readDocument(`privateLocations/${uid}`),
  ]);
  assert.fail(`Projection source timestamp not observed for ${uid}; ${JSON.stringify({
    expectedSourceLocationUpdatedAt: expectedSourceUpdatedAt,
    lastProjection: lastProjection && {
      gameSessionId: lastProjection.gameSessionId,
      safetyStatus: lastProjection.safetyStatus,
      sourceLocationUpdatedAt: lastProjection.sourceLocationUpdatedAt,
      projectedAt: lastProjection.projectedAt,
      expiresAt: lastProjection.expiresAt,
    },
    configSessionId: config?.gameSessionId,
    configSessionSchemaVersion: config?.sessionSchemaVersion,
    playerSessionId: player?.gameSessionId,
    playerStatus: player?.status,
    locationSessionId: location?.gameSessionId,
    locationUpdatedAt: location?.updatedAt,
    pollingStartedAt: startedAt,
    pollingEndedAt,
    elapsedMs: Date.now() - startedAt,
    harnessTimeoutMs: projectionHarnessTimeoutMs,
    timeoutMeaning: 'Emulator integration hang guard; not a production latency SLO',
  })}`);
}

async function waitForProjectionRemoval(uid) {
  const deadline = Date.now() + projectionHarnessTimeoutMs;
  while (Date.now() < deadline) {
    if (await readDocument(`emergencyLocationProjections/${uid}`) === null) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }
  assert.fail(`Projection remained after Player became ACTIVE within the Emulator harness limit: ${uid}`);
}

function timestampEpochMicros(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  assert.ok(match, `Expected Firestore RFC3339 timestamp, received ${value}`);
  const secondStartMs = Date.parse(`${match[1]}Z`);
  const fractionalMicros = BigInt((match[2] ?? '').padEnd(6, '0').slice(0, 6));
  return BigInt(secondStartMs) * 1_000n + fractionalMicros;
}

function percentileSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted[sorted.length - 1],
  };
}

async function nextFreshTimestamp(previous) {
  while (true) {
    const candidate = Date.now() - 10;
    if (candidate > previous) return candidate;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

before(clearEmulatorState);

describe('Emergency Projection trigger stability diagnostics', () => {
  test('20 unique Players project every committed same-coordinate location heartbeat and clean up on ACTIVE', async t => {
    await writeServer('game_config/current', {
      gameStatus: 'GAME_OVER',
      gameSessionId: sessionId,
      sessionStartedAt: Date.now() - 60_000,
      sessionSchemaVersion: 2,
      teamARole: 'ONI',
      teamBRole: 'RUNNER',
      teamAScore: 0,
      teamBScore: 0,
      logs: [],
    });

    let projectionWrites = 0;
    let projectionCleanup = 0;
    const projectionCommitLatenciesMs = [];
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const auth = await createAuthUser();
      const uid = auth.localId;
      await writeServer(`users/${uid}`, {
        id: uid,
        name: `Projection diagnostic ${iteration}`,
        team: iteration % 2 === 0 ? 'B' : 'A',
        status: 'EMERGENCY',
        gameSessionId: sessionId,
        score: 0,
        invincibleCards: 0,
        invincibleUntil: 0,
        waitingUntil: 0,
        shinkansenStartTime: null,
      });
      const player = await readDocument(`users/${uid}`);
      const config = await readDocument('game_config/current');
      assert.equal(player?.gameSessionId, config?.gameSessionId, `Player/Config Session mismatch for ${uid}`);
      assert.equal(player?.status, 'EMERGENCY');

      let sourceUpdatedAt = Date.now() - 1_000;
      const heartbeatCount = heartbeatsPerPlayer + 1;
      for (let heartbeat = 0; heartbeat < heartbeatCount; heartbeat += 1) {
        if (heartbeat > 0) sourceUpdatedAt = await nextFreshTimestamp(sourceUpdatedAt);
        const writeResult = await writePrivateLocation(auth, sourceUpdatedAt);
        assert.equal(typeof writeResult.updateTime, 'string', `Missing Firestore commit timestamp for ${uid}`);
        const location = await readDocumentSnapshot(`privateLocations/${uid}`);
        assert.equal(location?.data.gameSessionId, sessionId, `Location Session mismatch for ${uid}`);
        assert.equal(location?.data.updatedAt, sourceUpdatedAt, `Committed location timestamp mismatch for ${uid}`);
        assert.equal(location?.updateTime, writeResult.updateTime, `Location write response/readback commit mismatch for ${uid}`);

        const observed = await waitForProjection(uid, sourceUpdatedAt);
        assert.equal(observed.projection.gameSessionId, sessionId);
        assert.equal(observed.projection.playerId, uid);
        assert.equal(observed.projection.safetyStatus, 'EMERGENCY');
        assert.equal(observed.projection.projectionKind, 'EMERGENCY');
        assert.equal(observed.projection.sourceLocationUpdatedAt, location.data.updatedAt);
        assert.equal(observed.projection.latitude, 35.1);
        assert.equal(observed.projection.longitude, 139.1);
        assert.ok(observed.projection.expiresAt > observed.projection.projectedAt);
        const commitLatencyMs = Number(timestampEpochMicros(observed.updateTime)
          - timestampEpochMicros(writeResult.updateTime)) / 1_000;
        assert.ok(commitLatencyMs >= 0, `Projection commit predates location commit for ${uid}`);
        projectionCommitLatenciesMs.push(commitLatencyMs);
        projectionWrites += 1;
        t.diagnostic(`PROJECTION_LATENCY_SAMPLE ${JSON.stringify({
          uid,
          iteration,
          heartbeat,
          sourceUpdatedAt,
          locationCommitAt: writeResult.updateTime,
          projectionServiceStartedAt: new Date(observed.projection.projectedAt).toISOString(),
          projectionCommitAt: observed.updateTime,
          commitToCommitLatencyMs: commitLatencyMs,
          observationDelayMs: observed.elapsedMs,
          sessionMatch: true,
          status: observed.projection.safetyStatus,
        })}`);
      }

      await writeServer(`users/${uid}`, {
        ...player,
        status: 'ACTIVE',
      });
      await waitForProjectionRemoval(uid);
      projectionCleanup += 1;
      t.diagnostic(JSON.stringify({ uid, iteration, cleanup: 'complete', projectionCleanup }));
    }

    assert.equal(projectionWrites, iterations * (heartbeatsPerPlayer + 1));
    assert.equal(projectionCleanup, iterations);
    t.diagnostic(`PROJECTION_LATENCY_SUMMARY ${JSON.stringify({
      environment: 'Node 22 Firestore Emulator only; do not extrapolate to Production',
      measurement: 'Firestore private-location updateTime to Projection document updateTime',
      ...percentileSummary(projectionCommitLatenciesMs),
    })}`);
  });
});
