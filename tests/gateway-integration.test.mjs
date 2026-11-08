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
    // In unpatched rules (<= 11 min), this returns 403!
    // After fixing rule to 30 min (<= nowMs + 1860000), this will return 200!
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
    // Updates config: roles flip, teamBScore +50, lastCaptureTargetId = target.localId, nextRevealTime, logs
    // Updates all 4 users:
    // - Team A (new ONI): target & otherRunner both get WAITING (30 mins), invincibleUntil 0
    // - Team B (new RUNNER): captor & teammate both get ACTIVE, waitingUntil 0, invincibleCards +1
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
      // Captor B1: new RUNNER, ACTIVE, cards increment from 0 to 1
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${captor.localId}`,
          fields: fields({
            id: captor.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Captor B1', team: 'B', role: 'ONI',
            color: '#3b82f6', status: 'ACTIVE', score: 0, invincibleCards: 1, invincibleUntil: 0, waitingUntil: 0,
          }).fields,
        },
      },
      // Teammate B2: new RUNNER, ACTIVE, cards increment from 0 to 1
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${teammate.localId}`,
          fields: fields({
            id: teammate.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Teammate B2', team: 'B', role: 'ONI',
            color: '#3b82f6', status: 'ACTIVE', score: 0, invincibleCards: 1, invincibleUntil: 0, waitingUntil: 0,
          }).fields,
        },
      },
      // Target A1: new ONI, WAITING for 30 mins, invincibleUntil reset to 0
      {
        update: {
          name: `projects/${projectId}/databases/(default)/documents/users/${target.localId}`,
          fields: fields({
            id: target.localId, gameSessionId: CURRENT_SESSION_ID, name: 'Target A1', team: 'A', role: 'RUNNER',
            color: '#ef4444', status: 'WAITING', score: 30, invincibleCards: 1, invincibleUntil: 0, waitingUntil: waitingUntil,
          }).fields,
        },
      },
      // Other A2: new ONI, WAITING for 30 mins, invincibleUntil reset to 0
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
    // In PR #49 rules, this returns 403 because B1 (captor) and B2 (teammate) writes are rejected!
    // In our fixed rules, this MUST return 200!
    assert.equal(batchRes.status, 200, 'Real capture batch transaction MUST succeed with 200');
  });
});
