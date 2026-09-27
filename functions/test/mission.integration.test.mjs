import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createMissionCompletionId } from '../lib/functions/src/mission/missionService.js';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const firestoreBase = `http://127.0.0.1:8080/v1/projects/${projectId}/databases/(default)/documents`;
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts';
const functionsBase = `http://127.0.0.1:5001/${projectId}/asia-northeast1/completeMission`;
let idSequence = 0;

async function createAuthUser() {
  const response = await fetch(`${authBase}:signUp?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  assert.equal(response.ok, true, `Auth emulator failed to create a user: ${response.status}`);
  return response.json();
}

function encodeFields(values) {
  return {
    fields: Object.fromEntries(Object.entries(values).map(([key, value]) => {
      if (typeof value === 'number') return [key, { integerValue: String(value) }];
      if (typeof value === 'boolean') return [key, { booleanValue: value }];
      if (Array.isArray(value)) return [key, { arrayValue: { values: value.map(item => ({ stringValue: item })) } }];
      return [key, { stringValue: value }];
    })),
  };
}

async function seedDocument(path, values) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer owner',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(encodeFields(values)),
  });
  assert.equal(response.ok, true, `Firestore emulator seed failed for ${path}: ${response.status}`);
}

async function readDocument(path, token) {
  const response = await fetch(`${firestoreBase}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.ok, true, `Firestore emulator read failed for ${path}: ${response.status}`);
  return response.json();
}

function field(document, name) {
  const value = document.fields[name];
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.arrayValue !== undefined) return value.arrayValue.values ?? [];
  return value;
}

async function callMission(token, missionId) {
  const response = await fetch(functionsBase, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data: { missionId } }),
  });
  return { status: response.status, body: await response.json() };
}

async function setupMission(team = 'A') {
  idSequence += 1;
  const user = await createAuthUser();
  const missionId = `integration_mission_${idSequence}`;
  await seedDocument(`users/${user.localId}`, {
    id: user.localId,
    team,
    name: `Integration ${team}`,
    status: 'ACTIVE',
    score: 0,
    invincibleCards: 0,
  });
  await seedDocument(`missions/${missionId}`, {
    title: missionId,
    points: 25,
  });
  await seedDocument('game_config/current', {
    gameStatus: 'DAY1_ACTIVE',
    activeMissionA: team === 'A' ? missionId : 'not-active',
    activeMissionB: team === 'B' ? missionId : 'not-active',
    activeFinalMissionId: '',
    teamAScore: 0,
    teamBScore: 0,
    logs: [],
  });
  return { user, missionId };
}

describe('completeMission callable emulator integration', () => {
  test('authenticated active mission writes scores and completion atomically', async () => {
    const { user, missionId } = await setupMission('A');
    const response = await callMission(user.idToken, missionId);
    assert.equal(response.body.result.ok, true);
    assert.equal(response.body.result.missionId, missionId);

    const [player, config, completion] = await Promise.all([
      readDocument(`users/${user.localId}`, user.idToken),
      readDocument('game_config/current', user.idToken),
      readDocument(
        `missionCompletions/${createMissionCompletionId('A', missionId)}`,
        user.idToken,
      ),
    ]);
    assert.equal(field(player, 'score'), 25);
    assert.ok(field(config, 'teamAScore') >= 25);
    assert.equal(field(completion, 'team'), 'A');
    assert.equal(field(completion, 'missionId'), missionId);
    assert.equal(field(completion, 'completedBy'), user.localId);
    assert.equal(typeof completion.fields.completedAt.timestampValue, 'string');
    assert.ok(field(config, 'logs').length > 0);
  });

  test('duplicate TEAM + MISSION request does not award scores twice', async () => {
    const { user, missionId } = await setupMission('A');
    const first = await callMission(user.idToken, missionId);
    const second = await callMission(user.idToken, missionId);
    assert.equal(first.body.result.ok, true);
    assert.ok(second.body.error);

    const [player, config] = await Promise.all([
      readDocument(`users/${user.localId}`, user.idToken),
      readDocument('game_config/current', user.idToken),
    ]);
    assert.equal(field(player, 'score'), 25);
    assert.ok(field(config, 'teamAScore') >= 25);
  });

  test('rejects unauthenticated callable requests', async () => {
    const response = await callMission(null, 'some-mission');
    assert.ok(response.body.error);
    assert.equal(response.body.error.status, 'UNAUTHENTICATED');
  });

  test('rejects a mission that is not assigned to the player team', async () => {
    const { user, missionId } = await setupMission('A');
    const wrongMissionId = `${missionId}_wrong`;
    await seedDocument(`missions/${wrongMissionId}`, { title: wrongMissionId, points: 100 });

    const response = await callMission(user.idToken, wrongMissionId);
    assert.ok(response.body.error);
    const [player, config] = await Promise.all([
      readDocument(`users/${user.localId}`, user.idToken),
      readDocument('game_config/current', user.idToken),
    ]);
    assert.equal(field(player, 'score'), 0);
    assert.equal(field(config, 'teamAScore'), 0);
  });
});
