import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { createMissionCompletionId } from '../lib/functions/src/mission/missionService.js';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const documentsUrl = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const functionsUrl = `http://127.0.0.1:5001/${projectId}/asia-northeast1`;
const authUrl = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const firestoreClearUrl = `http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`;
const authClearUrl = `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/accounts`;
const projectionHarnessTimeoutMs = 30_000;

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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  assert.equal(response.ok, true, `Server fixture write failed at ${path}: ${response.status} ${await response.text()}`);
}

async function read(path, token = 'owner') {
  const response = await fetch(`${documentsUrl}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  if (!response.ok) return { denied: response.status };
  return decodeFields(await response.json());
}

async function readRevision(path) {
  const response = await fetch(`${documentsUrl}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (response.status === 404) return null;
  assert.equal(response.ok, true, `Revision read failed at ${path}: ${response.status}`);
  const document = await response.json();
  return { updateTime: document.updateTime ?? null, data: decodeFields(document) };
}

async function clientCommit(token, entries) {
  const response = await fetch(`${documentsUrl}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: entries.map(([path, data]) => ({
      update: {
        name: `projects/${projectId}/databases/(default)/documents/${path}`,
        fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])),
      },
    })) }),
  });
  return { status: response.status, body: await response.json() };
}

async function clientPatch(token, path, data) {
  const response = await fetch(`${documentsUrl}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])) }),
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

function adminIntent(sessionId, values = {}) {
  return { ...values, requestId: randomUUID(), expectedSessionId: sessionId };
}

function assertSuccess(response, label) {
  assert.equal(response.body.result?.ok, true, `${label}: ${JSON.stringify(response.body)}`);
  return response.body.result;
}

async function createLegacyPlayer(team, name) {
  const auth = await createAuthUser();
  await serverWrite(`users/${auth.localId}`, {
    id: auth.localId,
    name,
    role: 'RUNNER',
    color: team === 'A' ? '#dc2626' : '#2563eb',
    team,
    status: 'ACTIVE',
    score: 0,
    invincibleCards: 0,
    invincibleUntil: 0,
    waitingUntil: 0,
    shinkansenStartTime: null,
  });
  return auth;
}

async function createSetupPlayer(team, sessionId) {
  const auth = await createAuthUser();
  const user = {
    id: auth.localId,
    name: `Release Flow ${team}`,
    role: 'RUNNER',
    color: team === 'A' ? '#dc2626' : '#2563eb',
    team,
    score: 0,
    status: 'ACTIVE',
    gameSessionId: sessionId,
    invincibleCards: 0,
  };
  const location = {
    gameSessionId: sessionId,
    latitude: team === 'A' ? 35.6812 : 35.6895,
    longitude: team === 'A' ? 139.7671 : 139.6917,
    updatedAt: new Date(),
  };
  const result = await clientCommit(auth.idToken, [
    [`users/${auth.localId}`, user],
    [`privateLocations/${auth.localId}`, location],
  ]);
  assert.equal(result.status, 200, `Setup batch denied for Team ${team}: ${JSON.stringify(result.body)}`);
  assert.equal((await read(`users/${auth.localId}`)).gameSessionId, sessionId);
  assert.equal((await read(`privateLocations/${auth.localId}`)).gameSessionId, sessionId);
  return auth;
}

async function waitForDocument(path, predicate, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read(path, token);
    if (Date.now() <= deadline && value && !value.denied && predicate(value)) return value;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(100, remainingMs)));
  }
  assert.fail(`Document condition was not met for ${path} within the ${timeoutMs}ms Emulator harness limit`);
}

async function waitForMissing(path, token = 'owner') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await read(path, token) === null) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Document was not removed: ${path}`);
}

async function assertSessionChanged(response, label) {
  assert.equal(response.body.error?.details?.reason, 'SESSION_CHANGED', `${label}: ${JSON.stringify(response.body)}`);
}

async function registerLocation(auth, sessionId, latitude, longitude) {
  const result = await clientPatch(auth.idToken, `privateLocations/${auth.localId}`, {
    gameSessionId: sessionId,
    latitude,
    longitude,
    updatedAt: new Date(),
  });
  assert.equal(result.status, 200, `Location registration failed: ${JSON.stringify(result.body)}`);
}

describe('continuous release flow emulator integration', () => {
  before(clearEmulatorState);

  test('runs initialization, Setup, full game, trusted Reset, stale isolation, and new-Session continuation on one dataset', async () => {
    const admin = await createAuthUser();
    const legacyA = await createLegacyPlayer('A', 'Legacy A');
    const legacyB = await createLegacyPlayer('B', 'Legacy B');
    const unknownId = `unknown-${randomUUID()}`;
    await serverWrite(`admins/${admin.localId}`, { active: true });
    await serverWrite(`users/${admin.localId}`, { id: admin.localId, name: 'Admin Player', team: 'ADMIN', status: 'ACTIVE', score: 9 });
    await serverWrite(`users/${unknownId}`, { id: unknownId, name: 'Unknown Team', team: 'UNKNOWN', status: 'ACTIVE', score: 13 });
    await serverWrite('game_config/current', {
      gameStatus: 'PRE_GAME',
      day: 1,
      startTime: 0,
      finalMissionEndTime: 0,
      isFinalMissionActive: false,
      isGameOver: false,
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

    const initialization = assertSuccess(await call('initializeGameSession', { requestId: randomUUID() }, admin.idToken), 'initializeGameSession');
    const oldSessionId = initialization.gameSessionId;
    assert.equal(initialization.sessionSchemaVersion, 2);
    assert.ok(oldSessionId && oldSessionId !== 'legacy');
    assert.equal((await read(`users/${legacyA.localId}`)).gameSessionId, oldSessionId);
    assert.equal((await read(`users/${legacyB.localId}`)).gameSessionId, oldSessionId);
    const adminPlayerBeforeReset = await read(`users/${admin.localId}`);
    const unknownPlayerBeforeReset = await read(`users/${unknownId}`);
    await serverWrite(`privateLocations/${admin.localId}`, {
      gameSessionId: oldSessionId, latitude: 40, longitude: 140, updatedAt: new Date(),
    });
    await serverWrite(`privateLocations/${unknownId}`, {
      gameSessionId: oldSessionId, latitude: 41, longitude: 141, updatedAt: new Date(),
    });

    const playerA = await createSetupPlayer('A', oldSessionId);
    const playerB = await createSetupPlayer('B', oldSessionId);
    const privateA = await read(`privateLocations/${playerA.localId}`);
    const privateB = await read(`privateLocations/${playerB.localId}`);
    assert.equal(privateA.gameSessionId, oldSessionId);
    assert.equal(privateB.gameSessionId, oldSessionId);
    const crossPlayerLocation = await fetch(`${documentsUrl}/privateLocations/${playerA.localId}`, {
      headers: { Authorization: `Bearer ${playerB.idToken}` },
    });
    assert.equal(crossPlayerLocation.status, 403, 'cross-player private location read must remain denied');

    assertSuccess(await call('transitionGamePhase', adminIntent(oldSessionId, { action: 'START_DAY1' }), admin.idToken), 'START_DAY1');
    const sync = assertSuccess(await call('syncMissionCatalog', adminIntent(oldSessionId), admin.idToken), 'syncMissionCatalog');
    assert.ok(sync.totalManagedCount > 0);
    assertSuccess(await call('setMissionMode', adminIntent(oldSessionId, { mode: 'DIFFERENT' }), admin.idToken), 'setMissionMode');
    assertSuccess(await call('assignMissions', adminIntent(oldSessionId, {
      strategy: 'MANUAL', target: 'TEAM_A', missionId: 'm02',
    }), admin.idToken), 'assignMissions');

    const normalCompletionId = createMissionCompletionId(oldSessionId, 'A', 'm02');
    assertSuccess(await call('completeMission', { missionId: 'm02', expectedSessionId: oldSessionId }, playerA.idToken), 'DAY1 Mission Completion');
    const normalCompletion = await read(`missionCompletions/${normalCompletionId}`);
    assert.equal(normalCompletion.gameSessionId, oldSessionId);
    assert.equal(normalCompletion.completedBy, playerA.localId);
    assert.equal(normalCompletion.team, 'A');
    assert.ok(normalCompletion.points > 0);
    const scoreAfterCompletion = (await read('game_config/current')).teamAScore;
    const playerScoreAfterCompletion = (await read(`users/${playerA.localId}`)).score;
    assert.ok(scoreAfterCompletion >= normalCompletion.points);
    assert.equal(playerScoreAfterCompletion, normalCompletion.points);
    const duplicateCompletion = await call('completeMission', { missionId: 'm02', expectedSessionId: oldSessionId }, playerA.idToken);
    assert.ok(duplicateCompletion.body.error, 'same-Session duplicate Completion must reject');
    assert.equal((await read('game_config/current')).teamAScore, scoreAfterCompletion);
    assert.equal((await read(`users/${playerA.localId}`)).score, playerScoreAfterCompletion);

    const capture = assertSuccess(await call('capturePlayer', {
      targetId: playerB.localId, expectedSessionId: oldSessionId,
    }, playerA.idToken), 'capturePlayer');
    assert.equal(capture.capture.event.targetId, playerB.localId);
    const afterCapture = await Promise.all([
      read('game_config/current'), read(`users/${playerA.localId}`), read(`users/${playerB.localId}`),
    ]);
    assert.equal(afterCapture[0].teamARole, 'RUNNER');
    const cardsAfterCapture = normalCompletion.luckyReward ? 2 : 1;
    assert.equal(afterCapture[1].invincibleCards, cardsAfterCapture);
    assert.equal(afterCapture[2].status, 'WAITING');

    const waitingStarted = assertSuccess(await call('startWaiting', { expectedSessionId: oldSessionId }, playerA.idToken), 'startWaiting');
    const waitingPlayer = await read(`users/${playerA.localId}`);
    assert.equal(waitingPlayer.status, 'WAITING');
    assert.equal(waitingPlayer.waitingUntil, waitingStarted.waitingUntil);
    await call('transitionGamePhase', adminIntent(oldSessionId, { action: 'PAUSE' }), admin.idToken).then(response => assertSuccess(response, 'DAY1 PAUSE'));
    assert.equal((await read(`users/${playerA.localId}`)).waitingUntil, waitingPlayer.waitingUntil);
    await call('transitionGamePhase', adminIntent(oldSessionId, { action: 'RESUME' }), admin.idToken).then(response => assertSuccess(response, 'DAY1 RESUME'));
    assert.equal((await read(`users/${playerA.localId}`)).waitingUntil, waitingPlayer.waitingUntil);
    assertSuccess(await call('resumePlayer', { targetId: playerA.localId, expectedSessionId: oldSessionId }, admin.idToken), 'resumePlayer');
    const invincibility = assertSuccess(await call('activateInvincibility', { expectedSessionId: oldSessionId }, playerA.idToken), 'activateInvincibility');
    assert.equal(invincibility.remainingCards, cardsAfterCapture - 1);
    assert.ok((await read(`users/${playerA.localId}`)).invincibleUntil > Date.now());

    await registerLocation(playerA, oldSessionId, 35.6812, 139.7671);
    await registerLocation(playerB, oldSessionId, 35.6895, 139.6917);
    for (const location of await Promise.all([
      read(`privateLocations/${playerA.localId}`), read(`privateLocations/${playerB.localId}`),
    ])) {
      assert.equal(location.gameSessionId, oldSessionId);
      assert.ok(Date.now() - location.updatedAt < 120_000, 'Reveal fixture must have a fresh current-Session location');
    }

    const reveal = assertSuccess(await call('revealPlayerLocations', adminIntent(oldSessionId, {
      scope: 'GLOBAL', durationMinutes: 1,
    }), admin.idToken), 'GLOBAL Reveal');
    assert.ok(reveal.projectedCount >= 1);
    const currentSnapshots = await Promise.all([
      read(`exposedLocations/${playerA.localId}`), read(`exposedLocations/${playerB.localId}`),
    ]);
    for (const snapshot of currentSnapshots.filter(Boolean)) assert.equal(snapshot.gameSessionId, oldSessionId);

    const emergency = assertSuccess(await call('requestSafetyAction', {
      action: 'EMERGENCY', reasonCode: 'OTHER', expectedSessionId: oldSessionId,
    }, playerB.idToken), 'Emergency Action');
    assert.ok(['CREATED', 'REFRESHED'].includes(emergency.projectionStatus));
    const projectionPath = `emergencyLocationProjections/${playerB.localId}`;
    const projection = await waitForDocument(
          projectionPath,
          value => value.gameSessionId === oldSessionId && value.safetyStatus === 'EMERGENCY',
          admin.idToken,
          projectionHarnessTimeoutMs,
        );
    assert.equal(projection.gameSessionId, oldSessionId);
    const participantProjectionRead = await fetch(`${documentsUrl}/${projectionPath}`, {
      headers: { Authorization: `Bearer ${playerA.idToken}` },
    });
    assert.equal(participantProjectionRead.status, 403, 'Emergency Projection is Admin-only');
    assertSuccess(await call('requestSafetyAction', {
      action: 'RETIRE', reasonCode: 'RETIREMENT_REQUEST', expectedSessionId: oldSessionId,
    }, playerB.idToken), 'Retire Action');
    assert.equal(await read(projectionPath), null, 'Retire must clean its Projection');
    assertSuccess(await call('resumePlayer', { targetId: playerB.localId, expectedSessionId: oldSessionId }, admin.idToken), 'resume retired player');
    assertSuccess(await call('requestSafetyAction', {
      action: 'EMERGENCY', reasonCode: 'OTHER', expectedSessionId: oldSessionId,
    }, playerB.idToken), 'second Emergency Action');
    await waitForDocument(
      projectionPath,
      value => value.gameSessionId === oldSessionId && value.safetyStatus === 'EMERGENCY',
      admin.idToken,
      projectionHarnessTimeoutMs,
    );

    const phaseSequence = [
      ['END_DAY1', 'DAY1_ENDED'],
      ['START_DAY2', 'DAY2_ACTIVE'],
      ['PAUSE', 'DAY2_PAUSED'],
      ['RESUME', 'DAY2_ACTIVE'],
      ['START_FINAL', 'FINAL_MISSION'],
    ];
    for (const [action, expectedPhase] of phaseSequence) {
      const result = assertSuccess(await call('transitionGamePhase', adminIntent(oldSessionId, { action }), admin.idToken), action);
      assert.equal(result.newPhase, expectedPhase);
      assert.equal((await read('game_config/current')).gameStatus, expectedPhase);
    }
    const finalConfig = await read('game_config/current');
    const finalMissionId = finalConfig.activeFinalMissionId;
    assert.ok(finalMissionId);
    const finalMission = await read(`missions/${finalMissionId}`);
    assert.ok(finalMission, `Final catalog entry ${finalMissionId} must exist`);
    const finalCompletionId = createMissionCompletionId(oldSessionId, 'A', finalMissionId);
    assertSuccess(await call('completeMission', { missionId: finalMissionId, expectedSessionId: oldSessionId }, playerA.idToken), 'Final Mission Completion');
    const finalCompletion = await read(`missionCompletions/${finalCompletionId}`);
    assert.equal(finalCompletion.gameSessionId, oldSessionId);
    assert.equal(finalCompletion.isFinalMission, true);
    assertSuccess(await call('transitionGamePhase', adminIntent(oldSessionId, { action: 'END_GAME' }), admin.idToken), 'END_GAME');
    assert.equal((await read('game_config/current')).gameStatus, 'GAME_OVER');
    assert.equal((await read('game_config/current')).isGameOver, true);

    const configBeforeReset = await read('game_config/current');
    const projectionBeforePreview = await readRevision(projectionPath);
    const resetPreview = assertSuccess(await call('prepareGameReset', { expectedSessionId: oldSessionId }, admin.idToken), 'Reset Preview');
    assert.equal(resetPreview.currentSessionId, oldSessionId);
    assert.equal(resetPreview.participantCount, 4);
    assert.equal(resetPreview.privateLocationCount, 2);
    assert.equal(resetPreview.emergencyProjectionCount, 1);
    const confirmationPath = `admins/${admin.localId}/resetConfirmations/${resetPreview.confirmationToken}`;
    const confirmation = await read(confirmationPath);
    const projectionAfterPreview = await readRevision(projectionPath);
    const executeInput = {
      confirmationToken: resetPreview.confirmationToken,
      requestId: randomUUID(),
      expectedSessionId: oldSessionId,
    };
    const [resetOne, resetTwo] = await Promise.all([
      call('executeGameReset', executeInput, admin.idToken),
      call('executeGameReset', executeInput, admin.idToken),
    ]);
    if (!resetOne.body.result?.ok) {
      const [projectionAfterExecute, configAfterExecute] = await Promise.all([
        readRevision(projectionPath), readRevision('game_config/current'),
      ]);
      assert.fail(`Reset execute failed: ${JSON.stringify({
        reason: resetOne.body.error?.details?.reason ?? 'UNKNOWN',
        previewProjectionUpdateTime: projectionAfterPreview?.updateTime,
        projectionBeforePreviewUpdateTime: projectionBeforePreview?.updateTime,
        projectionAfterExecuteUpdateTime: projectionAfterExecute?.updateTime,
        confirmationCounts: confirmation && {
          participantCount: confirmation.participantCount,
          privateLocationCount: confirmation.privateLocationCount,
          exposedLocationCount: confirmation.exposedLocationCount,
          emergencyProjectionCount: confirmation.emergencyProjectionCount,
          estimatedWriteCount: confirmation.estimatedWriteCount,
        },
        configRevisionAfterExecute: configAfterExecute?.updateTime,
        currentGameSessionId: configAfterExecute?.data.gameSessionId,
        requestError: resetOne.body.error,
      })}`);
    }
    const resetResult = assertSuccess(resetOne, 'executeGameReset');
    assert.deepEqual(assertSuccess(resetTwo, 'concurrent execute replay'), resetResult);
    const newSessionId = resetResult.newSessionId;
    assert.ok(newSessionId && newSessionId !== oldSessionId);

    const configAfterReset = await read('game_config/current');
    assert.equal(configAfterReset.gameSessionId, newSessionId);
    assert.ok(configAfterReset.sessionStartedAt > initialization.sessionStartedAt);
    assert.equal(configAfterReset.sessionSchemaVersion, 2);
    assert.equal(configAfterReset.gameStatus, 'PRE_GAME');
    assert.equal(configAfterReset.day, 1);
    assert.equal(configAfterReset.teamAScore, 0);
    assert.equal(configAfterReset.teamBScore, 0);
    assert.equal(configAfterReset.missionMode, 'DIFFERENT');
    assert.equal(configAfterReset.activeMissionA, null);
    assert.equal(configAfterReset.activeMissionB, null);
    assert.equal(configAfterReset.activeFinalMissionId, null);
    assert.equal(configAfterReset.isFinalMissionActive, false);
    assert.equal(configAfterReset.isGameOver, false);
    assert.equal(configAfterReset.finalMissionEndTime, 0);
    for (const field of ['locationRevealUntil', 'teamARevealUntil', 'teamBRevealUntil']) assert.equal(configAfterReset[field], null);
    assert.equal(configAfterReset.logs[0].action, 'executeGameReset');
    assert.equal(configAfterReset.logs[0].gameSessionId, newSessionId);
    assert.equal(configAfterReset.logs.filter(log => log.action === 'executeGameReset').length, 1);

    for (const playerId of [legacyA.localId, legacyB.localId, playerA.localId, playerB.localId]) {
      const player = await read(`users/${playerId}`);
      assert.equal(player.gameSessionId, newSessionId);
      assert.equal(player.status, 'ACTIVE');
      assert.equal(player.score, 0);
      assert.equal(player.invincibleCards, 0);
      assert.equal(player.invincibleUntil, 0);
      assert.equal(player.waitingUntil, 0);
      assert.equal(player.shinkansenStartTime, null);
    }
    assert.deepEqual(await read(`users/${admin.localId}`), adminPlayerBeforeReset);
    assert.deepEqual(await read(`users/${unknownId}`), unknownPlayerBeforeReset);
    for (const path of [
      `privateLocations/${legacyA.localId}`, `privateLocations/${legacyB.localId}`,
      `privateLocations/${playerA.localId}`, `privateLocations/${playerB.localId}`,
      `exposedLocations/${playerA.localId}`, `exposedLocations/${playerB.localId}`,
      `emergencyLocationProjections/${playerA.localId}`, projectionPath,
    ]) assert.equal(await read(path), null, `${path} should be deleted by Reset`);
    assert.ok(await read(`privateLocations/${admin.localId}`), 'Admin location is outside the A/B reset scope');
    assert.ok(await read(`privateLocations/${unknownId}`), 'unknown-team location is outside the A/B reset scope');
    assert.equal((await read(`missions/${finalMissionId}`)).id, finalMissionId);
    assert.equal((await read(`missionCompletions/${normalCompletionId}`)).gameSessionId, oldSessionId);
    assert.equal((await read(`missionCompletions/${finalCompletionId}`)).gameSessionId, oldSessionId);
    assert.equal((await read(`admins/${admin.localId}/resetConfirmations/${resetPreview.confirmationToken}`)).used, true);
    const resetReceiptPath = `admins/${admin.localId}/gameResetRequests/${executeInput.requestId}`;
    assert.equal((await read(resetReceiptPath)).result.newSessionId, newSessionId);

    const resetStablePaths = [
      'game_config/current', `users/${playerA.localId}`, `users/${playerB.localId}`,
      `privateLocations/${playerA.localId}`, `privateLocations/${playerB.localId}`,
      `exposedLocations/${playerA.localId}`, `exposedLocations/${playerB.localId}`,
      projectionPath, resetReceiptPath,
    ];
    const afterResetSnapshot = await Promise.all(resetStablePaths.map(path => read(path)));
    assert.deepEqual(assertSuccess(await call('executeGameReset', executeInput, admin.idToken), 'stable Reset replay'), resetResult);
    assert.deepEqual(await Promise.all(resetStablePaths.map(path => read(path))), afterResetSnapshot);
    const changedPayload = await call('executeGameReset', {
      ...executeInput, confirmationToken: randomUUID(),
    }, admin.idToken);
    assert.equal(changedPayload.body.error.details.reason, 'REQUEST_ID_REUSED');
    assert.deepEqual(await Promise.all(resetStablePaths.map(path => read(path))), afterResetSnapshot);
    assert.deepEqual(configBeforeReset.logs.filter(log => log.action === 'executeGameReset'), []);
    assertSessionChanged(await call('executeGameReset', {
      ...executeInput, requestId: randomUUID(),
    }, admin.idToken), 'old Session Reset request');

    const newPhase = assertSuccess(await call('transitionGamePhase', adminIntent(newSessionId, { action: 'START_DAY1' }), admin.idToken), 'new Session START_DAY1');
    assert.equal(newPhase.newPhase, 'DAY1_ACTIVE');
    const staleRequestId = randomUUID();
    const staleModeRequestId = randomUUID();
    const staleSyncRequestId = randomUUID();
    const staleScoreRequestId = randomUUID();
    const stalePhaseRequestId = randomUUID();
    const staleRevealRequestId = randomUUID();
    const staleRoleSwapRequestId = randomUUID();
    const staleAssignmentRequestId = randomUUID();
    const staleResetPreview = await call('prepareGameReset', { expectedSessionId: oldSessionId }, admin.idToken);
    await assertSessionChanged(staleResetPreview, 'stale Reset Preview');

    const statePaths = [
      'game_config/current', `users/${playerA.localId}`, `users/${playerB.localId}`,
      `privateLocations/${playerA.localId}`, `privateLocations/${playerB.localId}`,
      `exposedLocations/${playerA.localId}`, `exposedLocations/${playerB.localId}`,
      `missionCompletions/${normalCompletionId}`, `missionCompletions/${finalCompletionId}`,
      'missions/m02',
      `admins/${admin.localId}/phaseTransitionRequests/${stalePhaseRequestId}`,
      `admins/${admin.localId}/roleSwapRequests/${staleRoleSwapRequestId}`,
      `admins/${admin.localId}/missionModeRequests/${staleModeRequestId}`,
      `admins/${admin.localId}/missionAssignmentRequests/${staleAssignmentRequestId}`,
      `admins/${admin.localId}/missionCatalogSyncRequests/${staleSyncRequestId}`,
      `admins/${admin.localId}/scoreAdjustmentRequests/${staleScoreRequestId}`,
      `admins/${admin.localId}/revealRequests/${staleRevealRequestId}`,
    ];
    const beforeStaleRequests = await Promise.all(statePaths.map(path => read(path)));
    const staleCalls = [
      ['completeMission', { missionId: 'm02', expectedSessionId: oldSessionId }, playerA.idToken],
      ['capturePlayer', { targetId: playerB.localId, expectedSessionId: oldSessionId }, playerA.idToken],
      ['activateInvincibility', { expectedSessionId: oldSessionId }, playerA.idToken],
      ['startWaiting', { expectedSessionId: oldSessionId }, playerA.idToken],
      ['requestSafetyAction', { action: 'EMERGENCY', reasonCode: 'OTHER', expectedSessionId: oldSessionId }, playerA.idToken],
      ['swapTeamRoles', { requestId: staleRoleSwapRequestId, expectedSessionId: oldSessionId }, admin.idToken],
      ['resumePlayer', { targetId: playerB.localId, expectedSessionId: oldSessionId }, admin.idToken],
      ['revealPlayerLocations', { scope: 'GLOBAL', durationMinutes: 1, requestId: staleRevealRequestId, expectedSessionId: oldSessionId }, admin.idToken],
      ['transitionGamePhase', { action: 'PAUSE', requestId: stalePhaseRequestId, expectedSessionId: oldSessionId }, admin.idToken],
      ['setMissionMode', { mode: 'SAME', requestId: staleModeRequestId, expectedSessionId: oldSessionId }, admin.idToken],
      ['assignMissions', { strategy: 'MANUAL', target: 'TEAM_A', missionId: 'm02', requestId: staleAssignmentRequestId, expectedSessionId: oldSessionId }, admin.idToken],
      ['syncMissionCatalog', { requestId: staleSyncRequestId, expectedSessionId: oldSessionId }, admin.idToken],
      ['adjustTeamScore', { team: 'A', delta: 1, reasonCode: 'CORRECTION', requestId: staleScoreRequestId, expectedSessionId: oldSessionId }, admin.idToken],
    ];
    for (const [name, data, token] of staleCalls) await assertSessionChanged(await call(name, data, token), name);
    const staleExecuteId = randomUUID();
    await assertSessionChanged(await call('executeGameReset', {
      confirmationToken: resetPreview.confirmationToken,
      requestId: staleExecuteId,
      expectedSessionId: oldSessionId,
    }, admin.idToken), 'stale Reset Execute');

    const stalePrivateWrite = await clientPatch(playerA.idToken, `privateLocations/${playerA.localId}`, {
      gameSessionId: oldSessionId,
      latitude: 35.68,
      longitude: 139.76,
      updatedAt: new Date(),
    });
    assert.equal(stalePrivateWrite.status, 403, 'old Session private location write must be denied');
    const staleExposureWrite = await clientCommit(playerA.idToken, [[`exposedLocations/${playerA.localId}`, {
      gameSessionId: oldSessionId,
      latitude: 35.68,
      longitude: 139.76,
      capturedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }]]);
    assert.equal(staleExposureWrite.status, 403, 'old Session individual exposure write must be denied');
    assert.deepEqual(await Promise.all(statePaths.map(path => read(path))), beforeStaleRequests);
    assert.equal(await read(`admins/${admin.localId}/gameResetRequests/${staleExecuteId}`), null);

    await serverWrite(`privateLocations/${playerA.localId}`, {
      gameSessionId: oldSessionId, latitude: 35.68, longitude: 139.76, updatedAt: new Date(),
    });
    await serverWrite(`privateLocations/${playerB.localId}`, {
      gameSessionId: oldSessionId, latitude: 35.69, longitude: 139.69, updatedAt: new Date(),
    });
    await serverWrite(`exposedLocations/${playerA.localId}`, {
      gameSessionId: oldSessionId,
      latitude: 35.68,
      longitude: 139.76,
      capturedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revealScope: 'INDIVIDUAL',
    });
    const oldExposedRead = await fetch(`${documentsUrl}/exposedLocations/${playerA.localId}`, {
      headers: { Authorization: `Bearer ${playerB.idToken}` },
    });
    assert.equal(oldExposedRead.status, 403, 'old Session exposed snapshot must be unreadable');

    const oldLocationSafety = assertSuccess(await call('requestSafetyAction', {
      action: 'EMERGENCY', reasonCode: 'OTHER', expectedSessionId: newSessionId,
    }, playerB.idToken), 'Emergency with old Session location');
    assert.equal(oldLocationSafety.projectionStatus, 'UNAVAILABLE');
    const oldProjectionSourceTime = new Date(Date.now() - 100);
    await serverWrite(projectionPath, {
      playerId: playerB.localId,
      gameSessionId: oldSessionId,
      latitude: 35.69,
      longitude: 139.69,
      projectedAt: new Date(),
      sourceLocationUpdatedAt: oldProjectionSourceTime,
      expiresAt: new Date(Date.now() + 60_000),
      safetyStatus: 'EMERGENCY',
      projectionKind: 'EMERGENCY',
    });
    const oldProjectionRead = await fetch(`${documentsUrl}/${projectionPath}`, {
      headers: { Authorization: `Bearer ${admin.idToken}` },
    });
    assert.equal(oldProjectionRead.status, 403, 'old Session Projection must be unreadable even to Admin');
    assertSuccess(await call('resumePlayer', { targetId: playerB.localId, expectedSessionId: newSessionId }, admin.idToken), 'resume after old Projection');
    await waitForMissing(projectionPath);

    await registerLocation(playerB, newSessionId, 35.6895, 139.6917);
    assert.equal((await read(`privateLocations/${playerB.localId}`)).gameSessionId, newSessionId);
    const postResetReveal = assertSuccess(await call('revealPlayerLocations', adminIntent(newSessionId, {
      scope: 'GLOBAL', durationMinutes: 1,
    }), admin.idToken), 'new Session Reveal with one current location');
    assert.equal(postResetReveal.projectedCount, 1, 'old Session private location must not enter current reveal');
    assert.equal((await read(`exposedLocations/${playerA.localId}`)).gameSessionId, oldSessionId, 'old snapshot must remain bound to its old Session and must not be refreshed from old private location');
    assert.equal((await read(`exposedLocations/${playerB.localId}`)).gameSessionId, newSessionId);

    await registerLocation(playerA, newSessionId, 35.6812, 139.7671);
    assert.equal((await read(`privateLocations/${playerA.localId}`)).gameSessionId, newSessionId);
    const individualExposure = await clientCommit(playerA.idToken, [[`exposedLocations/${playerA.localId}`, {
      gameSessionId: newSessionId,
      latitude: 35.6812,
      longitude: 139.7671,
      capturedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }]]);
    assert.equal(individualExposure.status, 200, `current Session individual exposure denied: ${JSON.stringify(individualExposure.body)}`);
    assert.equal((await read(`exposedLocations/${playerA.localId}`, playerA.idToken)).gameSessionId, newSessionId);
    const currentExposureRead = await fetch(`${documentsUrl}/exposedLocations/${playerA.localId}`, {
      headers: { Authorization: `Bearer ${playerB.idToken}` },
    });
    assert.equal(currentExposureRead.status, 200, 'current Session individual snapshot should be readable by a participant');

    assertSuccess(await call('setMissionMode', adminIntent(newSessionId, { mode: 'DIFFERENT' }), admin.idToken), 'new Session setMissionMode');
    assertSuccess(await call('assignMissions', adminIntent(newSessionId, {
      strategy: 'MANUAL', target: 'TEAM_A', missionId: 'm02',
    }), admin.idToken), 'new Session mission assignment');
    const newCompletionId = createMissionCompletionId(newSessionId, 'A', 'm02');
    assert.notEqual(newCompletionId, normalCompletionId);
    assertSuccess(await call('completeMission', {
      missionId: 'm02', expectedSessionId: newSessionId,
    }, playerA.idToken), 'same Mission in new Session');
    const newCompletion = await read(`missionCompletions/${newCompletionId}`);
    assert.equal(newCompletion.gameSessionId, newSessionId);
    assert.equal(newCompletion.team, 'A');
    assert.equal(newCompletion.missionId, 'm02');
    assert.ok(await read(`missionCompletions/${normalCompletionId}`), 'old Completion history must be retained');
    assert.equal((await read('game_config/current')).gameSessionId, newSessionId);
  });
});
