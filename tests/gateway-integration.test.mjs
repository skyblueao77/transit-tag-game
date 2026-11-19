import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const projectId = 'demo-no-project';
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const firestoreBase = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const CURRENT_SESSION_ID = 'session_integration_001';

async function clearFirestore() {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`, {
    method: 'DELETE',
  });
}

async function createAuthUser() {
  const res = await fetch(`${authBase}/accounts:signUp?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(res.ok, true, `Auth user creation failed: ${res.status}`);
  return res.json();
}

function fields(values) {
  return {
    fields: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value === null || value === undefined
          ? { nullValue: null }
          : value instanceof Date
            ? { timestampValue: value.toISOString() }
            : typeof value === 'number'
              ? Number.isInteger(value)
                ? { integerValue: String(value) }
                : { doubleValue: value }
              : typeof value === 'boolean'
                ? { booleanValue: value }
                : Array.isArray(value)
                  ? value.length === 0
                    ? { arrayValue: {} }
                    : { arrayValue: { values: value.map(v => (typeof v === 'string' ? { stringValue: v } : { mapValue: fields(v) })) } }
                  : { stringValue: value },
      ]),
    ),
  };
}

async function commitBatch(writes, token) {
  const response = await fetch(`http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ writes }),
  });
  return response;
}

async function seed(docPath, data) {
  const response = await fetch(`${firestoreBase}/${docPath}`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer owner',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fields(data)),
  });
  if (!response.ok) {
    const text = await response.text();
    console.error(`Seed failed for ${docPath} (${response.status}):`, text);
  }
  assert.equal(response.ok, true, `Failed to seed document ${docPath}: ${response.status}`);
  return response.json();
}

async function createPasswordAuthUser(emailPrefix) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await fetch(`${authBase}/accounts:signUp?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `${emailPrefix}_${suffix}@transit-tag.local`,
      password: 'Password123!',
      returnSecureToken: true,
    }),
  });
  assert.equal(res.ok, true, `Password auth user creation failed: ${res.status}`);
  return res.json();
}

describe('P0 Reproduction & Gateway Payload Integration Tests', () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  test('P0-2 Reproduction: 30-minute invincibility card activation payload', async () => {
    const user = await createAuthUser();
    const now = Date.now();
    const invincibilityDuration = 30 * 60 * 1000; // 30 minutes in domain (time.ts)
    const invincibleUntil = now + invincibilityDuration;

    // Setup game_config
    await seed('game_config/current', {
      gameSessionId: CURRENT_SESSION_ID,
      sessionStartedAt: now - 3600000,
      sessionSchemaVersion: 2,
      gameStatus: 'DAY1_ACTIVE',
      day: 1,
      missionMode: 'SAME',
      isGameOver: false,
      teamARole: 'RUNNER',
      teamBRole: 'ONI',
      teamAScore: 100,
      teamBScore: 50,
      logs: [],
    }, user.idToken);

    // Setup active runner with 1 card
    await seed(`users/${user.localId}`, {
      id: user.localId,
      gameSessionId: CURRENT_SESSION_ID,
      name: 'Runner 1',
      team: 'A',
      role: 'RUNNER',
      color: '#ef4444',
      status: 'ACTIVE',
      score: 50,
      invincibleCards: 1,
      invincibleUntil: 0,
      waitingUntil: 0,
    });

    // Payload sent by clientInvincibilityGateway.activate:
    // Decrement invincibleCards from 1 to 0, set invincibleUntil to now + 30 min
    const patchPayload = {
      id: user.localId,
      gameSessionId: CURRENT_SESSION_ID,
      name: 'Runner 1',
      team: 'A',
      role: 'RUNNER',
      color: '#ef4444',
      status: 'ACTIVE',
      score: 50,
      invincibleCards: 0,
      invincibleUntil: invincibleUntil,
      waitingUntil: 0,
    };

    const res = await fetch(`${firestoreBase}/users/${user.localId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${user.idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fields(patchPayload)),
    });

    console.log('[P0-2 Test] Invincibility activation response status:', res.status);
    assert.equal(res.status, 200, '30-minute invincibility activation MUST succeed with 200');
  });

  test('P0-1 Reproduction: Full capture transaction payload from clientCaptureGateway', async () => {
    const captor = await createAuthUser(); // Team B (ONI)
    const teammate = await createAuthUser(); // Team B (ONI teammate)
    const target = await createAuthUser(); // Team A (RUNNER target)
    const otherRunner = await createAuthUser(); // Team A (RUNNER other)
    const now = Date.now();

    // 1. Setup game_config
    await seed('game_config/current', {
      gameSessionId: CURRENT_SESSION_ID,
      sessionStartedAt: now - 3600000,
      sessionSchemaVersion: 2,
      gameStatus: 'DAY1_ACTIVE',
      day: 1,
      missionMode: 'SAME',
      isGameOver: false,
      teamARole: 'RUNNER',
      teamBRole: 'ONI',
      teamAScore: 100,
      teamBScore: 50,
      logs: [],
    });

    // 2. Setup 4 players
    await seed(`users/${captor.localId}`, {
      id: captor.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Captor B1', team: 'B', role: 'ONI',
      color: '#3b82f6', status: 'ACTIVE', score: 0, invincibleCards: 0, invincibleUntil: 0, waitingUntil: 0,
    });

    await seed(`users/${teammate.localId}`, {
      id: teammate.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Teammate B2', team: 'B', role: 'ONI',
      color: '#3b82f6', status: 'ACTIVE', score: 0, invincibleCards: 0, invincibleUntil: 0, waitingUntil: 0,
    });

    await seed(`users/${target.localId}`, {
      id: target.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Target A1', team: 'A', role: 'RUNNER',
      color: '#ef4444', status: 'ACTIVE', score: 30, invincibleCards: 1, invincibleUntil: 0, waitingUntil: 0,
    });

    await seed(`users/${otherRunner.localId}`, {
      id: otherRunner.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Other A2', team: 'A', role: 'RUNNER',
      color: '#ef4444', status: 'WAITING', score: 20, invincibleCards: 0, invincibleUntil: 0, waitingUntil: now + 600000,
    });

    // 3. The REAL clientCaptureGateway batch payload:
    const waitingUntil = now + 30 * 60 * 1000;
    const captureWrites = [
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/game_config/current`,
          fields: fields({
            gameSessionId: CURRENT_SESSION_ID, sessionStartedAt: now - 3600000, sessionSchemaVersion: 2,
            gameStatus: 'DAY1_ACTIVE', day: 1, missionMode: 'SAME', isGameOver: false,
            teamARole: 'ONI', teamBRole: 'RUNNER', teamAScore: 100, teamBScore: 100,
            nextRevealTime: waitingUntil, lastCaptureTargetId: target.localId,
            logs: [{ id: 'log_cap_1', timestamp: now, message: 'Team B が捕獲成功！', type: 'CAPTURE' }],
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${captor.localId}`,
          fields: fields({
            id: captor.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Captor B1', team: 'B', role: 'ONI',
            color: '#3b82f6', status: 'ACTIVE', score: 0, invincibleCards: 1, invincibleUntil: 0, waitingUntil: 0,
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${teammate.localId}`,
          fields: fields({
            id: teammate.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Teammate B2', team: 'B', role: 'ONI',
            color: '#3b82f6', status: 'ACTIVE', score: 0, invincibleCards: 1, invincibleUntil: 0, waitingUntil: 0,
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${target.localId}`,
          fields: fields({
            id: target.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Target A1', team: 'A', role: 'RUNNER',
            color: '#ef4444', status: 'WAITING', score: 30, invincibleCards: 1, invincibleUntil: 0, waitingUntil: waitingUntil,
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${otherRunner.localId}`,
          fields: fields({
            id: otherRunner.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Other A2', team: 'A', role: 'RUNNER',
            color: '#ef4444', status: 'WAITING', score: 20, invincibleCards: 0, invincibleUntil: 0, waitingUntil: waitingUntil,
          }).fields,
        },
      },
    ];

    const batchRes = await commitBatch(captureWrites, captor.idToken);
    console.log('[P0-1 Test] Real capture batch commit status:', batchRes.status);
    assert.equal(batchRes.status, 200, 'Real capture batch transaction MUST succeed with 200');
  });

  test('Phase 4 Integration: joinCode invite gate allows valid password signup batch and denies invalid joinCode', async () => {
    const validPlayer = await createPasswordAuthUser('runner_valid');
    const invalidPlayer = await createPasswordAuthUser('runner_invalid');
    const now = Date.now();
    const validJoinCode = '0123456789abcdef0123456789abcdef';

    await seed('game_config/current', {
      gameSessionId: CURRENT_SESSION_ID,
      sessionStartedAt: now - 60000,
      sessionSchemaVersion: 2,
      gameStatus: 'PRE_GAME',
      registrationOpen: true,
      currentJoinCode: validJoinCode,
      day: 1,
      missionMode: 'DIFFERENT',
      teamARole: 'RUNNER',
      teamBRole: 'ONI',
      teamAScore: 0,
      teamBScore: 0,
      logs: [],
    });

    await seed(`joinCodes/${validJoinCode}`, {
      code: validJoinCode,
      gameSessionId: CURRENT_SESSION_ID,
      active: true,
      createdAt: now,
    });

    const invalidBatchRes = await commitBatch([
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${invalidPlayer.localId}`,
          fields: fields({
            id: invalidPlayer.localId,
            name: '侵入テスト',
            role: 'RUNNER',
            team: 'A',
            color: '#ef4444',
            score: 0,
            status: 'ACTIVE',
            gameSessionId: CURRENT_SESSION_ID,
            invincibleCards: 0,
            joinCode: 'wrongcodewrongcodewrongcodewrong',
          }).fields,
        },
        currentDocument: { exists: false },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/privateLocations/${invalidPlayer.localId}`,
          fields: fields({
            gameSessionId: CURRENT_SESSION_ID,
            latitude: 35.6812,
            longitude: 139.7671,
          }).fields,
        },
        currentDocument: { exists: false },
      },
    ], invalidPlayer.idToken);
    assert.equal(invalidBatchRes.status, 403, 'Signup with wrong joinCode MUST be rejected with 403');

    const validBatchRes = await commitBatch([
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${validPlayer.localId}`,
          fields: fields({
            id: validPlayer.localId,
            name: '正規参加者',
            role: 'RUNNER',
            team: 'A',
            color: '#ef4444',
            score: 0,
            status: 'ACTIVE',
            gameSessionId: CURRENT_SESSION_ID,
            invincibleCards: 0,
            joinCode: validJoinCode,
          }).fields,
        },
        currentDocument: { exists: false },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/privateLocations/${validPlayer.localId}`,
          fields: fields({
            gameSessionId: CURRENT_SESSION_ID,
            latitude: 35.6812,
            longitude: 139.7671,
          }).fields,
          updateTransforms: [
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        },
        currentDocument: { exists: false },
      },
    ], validPlayer.idToken);
    assert.equal(validBatchRes.status, 200, 'Signup with valid joinCode MUST succeed with 200');
  });

  test('Phase 4 Integration: Admin Master Reset batch rotates joinCode, resets users, and deletes private/exposed/projection/completion docs', async () => {
    const adminUser = await createPasswordAuthUser('admin_reset');
    const playerUser = await createPasswordAuthUser('player_reset');
    const now = Date.now();
    const oldJoinCode = 'aaaa1111bbbb2222cccc3333dddd4444';
    const newJoinCode = 'ffff9999eeee8888dddd7777cccc6666';
    const nextSessionId = 'session_integration_002';

    await seed(`admins/${adminUser.localId}`, {
      role: 'admin',
      createdAt: new Date(now - 10000),
    });
    await seed('game_config/current', {
      gameSessionId: CURRENT_SESSION_ID,
      sessionStartedAt: now - 3600000,
      sessionSchemaVersion: 2,
      currentJoinCode: oldJoinCode,
      registrationOpen: false,
      gameStatus: 'GAME_OVER',
      day: 2,
      teamARole: 'ONI',
      teamBRole: 'RUNNER',
      teamAScore: 120,
      teamBScore: 80,
      logs: [],
    });
    await seed(`joinCodes/${oldJoinCode}`, {
      code: oldJoinCode,
      gameSessionId: CURRENT_SESSION_ID,
      active: true,
      createdAt: now - 3600000,
    });
    await seed(`users/${playerUser.localId}`, {
      id: playerUser.localId,
      gameSessionId: CURRENT_SESSION_ID,
      name: 'Player One',
      team: 'A',
      role: 'ONI',
      color: '#ef4444',
      status: 'CAPTURED',
      score: 50,
      invincibleCards: 2,
      invincibleUntil: 0,
      waitingUntil: 0,
    });
    await seed(`privateLocations/${playerUser.localId}`, {
      gameSessionId: CURRENT_SESSION_ID,
      latitude: 35.68,
      longitude: 139.76,
      updatedAt: new Date(now - 5000),
    });
    await seed(`exposedLocations/${playerUser.localId}`, {
      gameSessionId: CURRENT_SESSION_ID,
      latitude: 35.68,
      longitude: 139.76,
      capturedAt: new Date(now - 5000),
      expiresAt: new Date(now + 60000),
      revealScope: 'GLOBAL',
    });
    await seed(`emergencyLocationProjections/${playerUser.localId}`, {
      playerId: playerUser.localId,
      gameSessionId: CURRENT_SESSION_ID,
      latitude: 35.68,
      longitude: 139.76,
      projectedAt: new Date(now - 5000),
      sourceLocationUpdatedAt: new Date(now - 6000),
      expiresAt: new Date(now + 60000),
      safetyStatus: 'EMERGENCY',
      projectionKind: 'EMERGENCY',
    });
    await seed(`missionCompletions/A_${CURRENT_SESSION_ID}_m1`, {
      gameSessionId: CURRENT_SESSION_ID,
      missionId: 'm1',
      team: 'A',
      completedBy: playerUser.localId,
      points: 20,
      luckyReward: false,
      isFinalMission: false,
      completedAt: new Date(now - 5000),
    });

    const resetBatchWrites = [
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/game_config/current`,
          fields: fields({
            gameSessionId: nextSessionId,
            sessionStartedAt: now,
            sessionSchemaVersion: 2,
            currentJoinCode: newJoinCode,
            registrationOpen: true,
            gameStatus: 'PRE_GAME',
            day: 1,
            teamARole: 'RUNNER',
            teamBRole: 'ONI',
            teamAScore: 0,
            teamBScore: 0,
            lastCaptureTargetId: null,
            logs: [{ id: 'log_reset_1', timestamp: now, message: 'リセット実行', type: 'SYSTEM' }],
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/joinCodes/${oldJoinCode}`,
          fields: fields({
            code: oldJoinCode,
            gameSessionId: CURRENT_SESSION_ID,
            active: false,
            createdAt: now - 3600000,
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/joinCodes/${newJoinCode}`,
          fields: fields({
            code: newJoinCode,
            gameSessionId: nextSessionId,
            active: true,
            createdAt: now,
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${playerUser.localId}`,
          fields: fields({
            id: playerUser.localId,
            gameSessionId: nextSessionId,
            name: 'Player One',
            team: 'A',
            role: 'RUNNER',
            color: '#ef4444',
            status: 'ACTIVE',
            score: 0,
            invincibleCards: 0,
            invincibleUntil: 0,
            waitingUntil: 0,
          }).fields,
        },
      },
      { delete: `projects/${projectId}/databases/(default)/documents/privateLocations/${playerUser.localId}` },
      { delete: `projects/${projectId}/databases/(default)/documents/exposedLocations/${playerUser.localId}` },
      { delete: `projects/${projectId}/databases/(default)/documents/emergencyLocationProjections/${playerUser.localId}` },
      { delete: `projects/${projectId}/databases/(default)/documents/missionCompletions/A_${CURRENT_SESSION_ID}_m1` },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/admins/${adminUser.localId}/resetReceipts/reset_req_1`,
          fields: fields({
            requestId: 'reset_req_1',
            expectedSessionId: CURRENT_SESSION_ID,
            newSessionId: nextSessionId,
            createdAt: now,
          }).fields,
        },
      },
    ];

    const resetRes = await commitBatch(resetBatchWrites, adminUser.idToken);
    assert.equal(resetRes.status, 200, 'Admin master reset batch MUST succeed with 200');
  });

  test('Phase 4 Integration: SURVIVAL resume clears lastCaptureTargetId and allows re-capture of same target', async () => {
    const adminUser = await createPasswordAuthUser('admin_survival');
    const captor = await createPasswordAuthUser('oni_captor');
    const target = await createPasswordAuthUser('runner_target');
    const now = Date.now();

    await seed(`admins/${adminUser.localId}`, {
      role: 'admin',
      createdAt: new Date(now - 10000),
    });
    await seed('game_config/current', {
      gameSessionId: CURRENT_SESSION_ID,
      sessionStartedAt: now - 3600000,
      sessionSchemaVersion: 2,
      victoryMode: 'SURVIVAL',
      gameStatus: 'DAY1_ACTIVE',
      day: 1,
      missionMode: 'SAME',
      isGameOver: false,
      teamARole: 'RUNNER',
      teamBRole: 'ONI',
      teamAScore: 0,
      teamBScore: 50,
      lastCaptureTargetId: target.localId,
      logs: [],
    });
    await seed(`users/${captor.localId}`, {
      id: captor.localId,
      gameSessionId: CURRENT_SESSION_ID,
      name: 'Oni Captor',
      team: 'B',
      role: 'ONI',
      color: '#3b82f6',
      status: 'ACTIVE',
      score: 0,
      invincibleCards: 0,
      invincibleUntil: 0,
      waitingUntil: 0,
    });
    await seed(`users/${target.localId}`, {
      id: target.localId,
      gameSessionId: CURRENT_SESSION_ID,
      name: 'Target Runner',
      team: 'A',
      role: 'RUNNER',
      color: '#ef4444',
      status: 'CAPTURED',
      score: 0,
      invincibleCards: 0,
      invincibleUntil: 0,
      waitingUntil: 0,
    });

    // Admin resumes target and clears lastCaptureTargetId
    const resumeRes = await commitBatch([
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${target.localId}`,
          fields: fields({
            id: target.localId,
            gameSessionId: CURRENT_SESSION_ID,
            name: 'Target Runner',
            team: 'A',
            role: 'RUNNER',
            color: '#ef4444',
            status: 'ACTIVE',
            score: 0,
            invincibleCards: 0,
            invincibleUntil: 0,
            waitingUntil: 0,
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/game_config/current`,
          fields: fields({
            gameSessionId: CURRENT_SESSION_ID,
            sessionStartedAt: now - 3600000,
            sessionSchemaVersion: 2,
            victoryMode: 'SURVIVAL',
            gameStatus: 'DAY1_ACTIVE',
            day: 1,
            missionMode: 'SAME',
            isGameOver: false,
            teamARole: 'RUNNER',
            teamBRole: 'ONI',
            teamAScore: 0,
            teamBScore: 50,
            lastCaptureTargetId: null,
            logs: [{ id: 'log_res_1', timestamp: now, message: '復帰処理', type: 'SYSTEM' }],
          }).fields,
        },
      },
    ], adminUser.idToken);
    assert.equal(resumeRes.status, 200, 'Admin SURVIVAL resume MUST succeed with 200');

    // Oni re-captures the same target in SURVIVAL mode
    const recaptureRes = await commitBatch([
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/game_config/current`,
          fields: fields({
            gameSessionId: CURRENT_SESSION_ID,
            sessionStartedAt: now - 3600000,
            sessionSchemaVersion: 2,
            victoryMode: 'SURVIVAL',
            gameStatus: 'DAY1_ACTIVE',
            day: 1,
            missionMode: 'SAME',
            isGameOver: false,
            teamARole: 'RUNNER',
            teamBRole: 'ONI',
            teamAScore: 0,
            teamBScore: 100,
            lastCaptureTargetId: target.localId,
            logs: [{ id: 'log_recap_1', timestamp: now, message: '再捕獲', type: 'CAPTURE' }],
          }).fields,
        },
      },
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${target.localId}`,
          fields: fields({
            id: target.localId,
            gameSessionId: CURRENT_SESSION_ID,
            name: 'Target Runner',
            team: 'A',
            role: 'RUNNER',
            color: '#ef4444',
            status: 'CAPTURED',
            score: 0,
            invincibleCards: 0,
            invincibleUntil: 0,
            waitingUntil: 0,
          }).fields,
        },
      },
    ], captor.idToken);
    assert.equal(recaptureRes.status, 200, 'SURVIVAL re-capture after admin resume MUST succeed with 200');
  });
});
