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

let captureSequence = 0;

async function callCapture(token, targetId, extra = {}) {
  const response = await fetch(
    `http://127.0.0.1:5001/${projectId}/asia-northeast1/capturePlayer`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ data: { targetId, ...extra } }),
    },
  );
  return { status: response.status, body: await response.json() };
}

async function setupCapture({ invincibleTarget = false } = {}) {
  captureSequence += 1;
  const suffix = `capture_${captureSequence}`;
  const captors = await Promise.all([createAuthUser(), createAuthUser()]);
  const targets = await Promise.all([createAuthUser(), createAuthUser()]);
  const players = [
    ...captors.map((user, index) => ({
      user,
      id: user.localId,
      team: 'A',
      name: `Capture Oni ${index}`,
      status: 'ACTIVE',
      score: 70 + index,
      invincibleCards: 0,
      invincibleUntil: 0,
    })),
    ...targets.map((user, index) => ({
      user,
      id: user.localId,
      team: 'B',
      name: `Capture Runner ${index}`,
      status: 'ACTIVE',
      score: 90 + index,
      invincibleCards: 0,
      invincibleUntil: invincibleTarget && index === 0 ? Date.now() + 600_000 : 0,
    })),
  ];
  await Promise.all(players.map(player => seedDocument(`users/${player.id}`, {
    id: player.id,
    team: player.team,
    name: player.name,
    status: player.status,
    score: player.score,
    invincibleCards: player.invincibleCards,
    invincibleUntil: player.invincibleUntil,
  })));
  await seedDocument('game_config/current', {
    gameStatus: 'DAY1_ACTIVE',
    teamARole: 'ONI',
    teamBRole: 'RUNNER',
    teamAScore: 11,
    teamBScore: 22,
    nextRevealTime: 0,
    logs: [],
  });
  return { suffix, captors, targets, players };
}

function rawLog(config) {
  const log = config.fields.logs.arrayValue.values[0].mapValue.fields;
  return {
    id: log.id.stringValue,
    timestamp: Number(log.timestamp.integerValue ?? log.timestamp.doubleValue),
    message: log.message.stringValue,
    type: log.type.stringValue,
  };
}

describe('capturePlayer callable emulator integration', () => {
  test('authenticated capture atomically swaps roles and updates the full A/B roster', async () => {
    const { captors, targets, players } = await setupCapture();
    const response = await callCapture(captors[0].idToken, targets[0].localId);
    assert.equal(response.body.result.ok, true);
    assert.equal(response.body.result.capture.event.targetId, targets[0].localId);

    const [config, ...documents] = await Promise.all([
      readDocument('game_config/current', captors[0].idToken),
      ...players.map(player => readDocument(`users/${player.id}`, captors[0].idToken)),
    ]);
    assert.equal(field(config, 'teamARole'), 'RUNNER');
    assert.equal(field(config, 'teamBRole'), 'ONI');
    assert.equal(field(config, 'teamAScore'), 61);
    assert.equal(field(config, 'teamBScore'), 22);
    assert.ok(field(config, 'nextRevealTime') > Date.now());
    assert.equal(documents[0].fields.score.integerValue, '70');
    assert.equal(field(documents[0], 'invincibleCards'), 1);
    assert.equal(documents[1].fields.score.integerValue, '71');
    assert.equal(field(documents[1], 'invincibleCards'), 1);
    assert.equal(field(documents[2], 'status'), 'WAITING');
    assert.equal(field(documents[2], 'waitingUntil'), field(config, 'nextRevealTime'));
    assert.equal(field(documents[2], 'invincibleUntil'), 0);
    assert.equal(documents[2].fields.score.integerValue, '90');
    assert.equal(field(documents[3], 'status'), 'WAITING');
    assert.equal(field(documents[3], 'invincibleUntil'), 0);
    assert.equal(field(config, 'logs').length, 1);
    const log = rawLog(config);
    assert.equal(log.type, 'CAPTURE');
    assert.equal(log.timestamp, field(config, 'nextRevealTime') - 30 * 60 * 1000);
    assert.match(log.message, /Team A/);
    assert.match(log.message, /\+50pt/);
  });

  test('rejects unauthenticated capture requests', async () => {
    const { targets } = await setupCapture();
    const response = await callCapture(null, targets[0].localId);
    assert.ok(response.body.error);
    assert.equal(response.body.error.status, 'UNAUTHENTICATED');
  });

  test('rejects an unknown target without changing authoritative state', async () => {
    const { captors } = await setupCapture();
    const response = await callCapture(captors[0].idToken, 'missing-capture-target');
    assert.ok(response.body.error);
    const config = await readDocument('game_config/current', captors[0].idToken);
    assert.equal(field(config, 'teamAScore'), 11);
    assert.equal(field(config, 'teamARole'), 'ONI');
    assert.equal(field(config, 'logs').length, 0);
  });

  test('rejects an invincible target without changing scores', async () => {
    const { captors, targets } = await setupCapture({ invincibleTarget: true });
    const response = await callCapture(captors[0].idToken, targets[0].localId);
    assert.ok(response.body.error);
    const [config, target] = await Promise.all([
      readDocument('game_config/current', captors[0].idToken),
      readDocument(`users/${targets[0].localId}`, captors[0].idToken),
    ]);
    assert.equal(field(config, 'teamAScore'), 11);
    assert.equal(field(config, 'logs').length, 0);
    assert.equal(field(target, 'status'), 'ACTIVE');
  });

  test('repeated capture awards reward, cards, and log only once', async () => {
    const { captors, targets, players } = await setupCapture();
    const first = await callCapture(captors[0].idToken, targets[0].localId);
    const second = await callCapture(captors[0].idToken, targets[0].localId);
    assert.equal(first.body.result.ok, true);
    assert.ok(second.body.error);
    const [config, ...documents] = await Promise.all([
      readDocument('game_config/current', captors[0].idToken),
      ...players.map(player => readDocument(`users/${player.id}`, captors[0].idToken)),
    ]);
    assert.equal(field(config, 'teamAScore'), 61);
    assert.equal(field(config, 'logs').length, 1);
    assert.equal(field(documents[0], 'invincibleCards'), 1);
    assert.equal(field(documents[1], 'invincibleCards'), 1);
  });

  test('concurrent captures of one target commit only one reward and log', async () => {
    const { captors, targets, players } = await setupCapture();
    const responses = await Promise.all([
      callCapture(captors[0].idToken, targets[0].localId),
      callCapture(captors[1].idToken, targets[0].localId),
    ]);
    assert.equal(responses.filter(response => response.body.result?.ok === true).length, 1);
    assert.equal(responses.filter(response => Boolean(response.body.error)).length, 1);

    const [config, ...documents] = await Promise.all([
      readDocument('game_config/current', captors[0].idToken),
      ...players.map(player => readDocument(`users/${player.id}`, captors[0].idToken)),
    ]);
    assert.equal(field(config, 'teamAScore'), 61);
    assert.equal(field(config, 'logs').length, 1);
    assert.equal(field(documents[0], 'invincibleCards'), 1);
    assert.equal(field(documents[1], 'invincibleCards'), 1);
  });
});
