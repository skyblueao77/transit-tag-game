import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  completeMissionForPlayer,
  createMissionCompletionId,
  MissionServiceError,
} from '../lib/functions/src/mission/missionService.js';

function fixture(overrides = {}) {
  const state = {
    player: {
      name: 'Runner A',
      team: 'A',
      status: 'ACTIVE',
      score: 10,
      invincibleCards: 2,
    },
    config: {
      gameStatus: 'DAY1_ACTIVE',
      activeMissionA: 'mission-1',
      activeMissionB: 'mission-1',
      activeFinalMissionId: 'final-1',
      teamAScore: 50,
      teamBScore: 60,
      logs: [],
    },
    mission: { title: 'Test mission', points: 25 },
    completions: new Set(),
    writes: [],
    ...overrides,
  };
  const store = {
    async runTransaction(work) {
      let pendingWrite;
      const transaction = {
        readPlayer: async () => state.player,
        readGameConfig: async () => state.config,
        readMission: async () => state.mission,
        readCompletion: async id => state.completions.has(id),
        writeMissionCompletion: write => { pendingWrite = structuredClone(write); },
      };
      const result = await work(transaction);
      if (pendingWrite) {
        state.writes.push(pendingWrite);
        state.completions.add(pendingWrite.completionId);
        state.player.score = pendingWrite.playerScore;
        state.player.invincibleCards = pendingWrite.invincibleCards;
        const scoreKey = pendingWrite.completion.team === 'A' ? 'teamAScore' : 'teamBScore';
        state.config[scoreKey] = pendingWrite.teamScore;
        state.config.logs = pendingWrite.logs;
      }
      return result;
    },
  };
  return { state, store };
}

function fixedRuntime(randomValue = 0.5, time = 1_700_000_000_000) {
  let randomCalls = 0;
  let nowCalls = 0;
  return {
    random: () => { randomCalls += 1; return randomValue; },
    now: () => { nowCalls += 1; return time; },
    calls: () => ({ randomCalls, nowCalls }),
  };
}

async function rejectsWith(reason, callback) {
  await assert.rejects(callback, error => {
    assert.ok(error instanceof MissionServiceError);
    assert.equal(error.reason, reason);
    return true;
  });
}

describe('server mission completion service', () => {
  test('rejects unknown players and unknown missions', async () => {
    const missingPlayer = fixture({ player: null });
    await rejectsWith('PLAYER_NOT_FOUND', () => completeMissionForPlayer(
      'uid-a', 'mission-1', missingPlayer.store, fixedRuntime(),
    ));

    const missingMission = fixture({ mission: null });
    await rejectsWith('MISSION_NOT_FOUND', () => completeMissionForPlayer(
      'uid-a', 'mission-1', missingMission.store, fixedRuntime(),
    ));
  });

  test('rejects invalid team, inactive player, invalid mission id, and unavailable phase', async () => {
    const invalidTeam = fixture({ player: { ...fixture().state.player, team: 'ADMIN' } });
    await rejectsWith('INVALID_PLAYER_TEAM', () => completeMissionForPlayer(
      'uid-a', 'mission-1', invalidTeam.store, fixedRuntime(),
    ));

    const inactivePlayer = fixture({ player: { ...fixture().state.player, status: 'WAITING' } });
    await rejectsWith('PLAYER_NOT_ACTIVE', () => completeMissionForPlayer(
      'uid-a', 'mission-1', inactivePlayer.store, fixedRuntime(),
    ));

    const invalidId = fixture();
    await rejectsWith('INVALID_ARGUMENT', () => completeMissionForPlayer(
      'uid-a', '../mission', invalidId.store, fixedRuntime(),
    ));
    await rejectsWith('INVALID_ARGUMENT', () => completeMissionForPlayer(
      'uid-a', '', invalidId.store, fixedRuntime(),
    ));

    const paused = fixture({ config: { ...fixture().state.config, gameStatus: 'DAY1_PAUSED' } });
    await rejectsWith('MISSION_NOT_ALLOWED', () => completeMissionForPlayer(
      'uid-a', 'mission-1', paused.store, fixedRuntime(),
    ));
    assert.equal(paused.state.writes.length, 0);
  });

  test('requires the current team mission assignment', async () => {
    const wrongMission = fixture({
      config: { ...fixture().state.config, activeMissionA: 'another-mission' },
    });
    await rejectsWith('MISSION_NOT_ACTIVE', () => completeMissionForPlayer(
      'uid-a', 'mission-1', wrongMission.store, fixedRuntime(),
    ));
    assert.equal(wrongMission.state.writes.length, 0);
  });

  test('completes Normal Mission in DAY1_ACTIVE and updates authoritative scores', async () => {
    const { state, store } = fixture();
    const result = await completeMissionForPlayer('uid-a', 'mission-1', store, fixedRuntime());

    assert.deepEqual(result, {
      ok: true,
      missionId: 'mission-1',
      reward: { missionId: 'mission-1', points: 25, isFinalMission: false },
      score: {
        teamScoreDelta: 25,
        playerScoreDelta: 25,
        invincibleCardDelta: 0,
        luckyReward: false,
      },
      isFinalMission: false,
    });
    assert.equal(state.player.score, 35);
    assert.equal(state.player.invincibleCards, 2);
    assert.equal(state.config.teamAScore, 75);
    assert.equal(state.config.teamBScore, 60);
  });

  test('completes Normal Mission in DAY2_ACTIVE', async () => {
    const data = fixture();
    data.state.config.gameStatus = 'DAY2_ACTIVE';
    const result = await completeMissionForPlayer(
      'uid-a', 'mission-1', data.store, fixedRuntime(),
    );
    assert.equal(result.isFinalMission, false);
    assert.equal(result.ok, true);
  });

  test('determines Final Mission from current phase and final assignment', async () => {
    const data = fixture();
    data.state.config.gameStatus = 'FINAL_MISSION';
    data.state.mission = { title: 'Final mission', points: 100 };
    const result = await completeMissionForPlayer(
      'uid-a', 'final-1', data.store, fixedRuntime(),
    );
    assert.equal(result.isFinalMission, true);
    assert.deepEqual(result.reward, {
      missionId: 'final-1', points: 100, isFinalMission: true,
    });
    assert.equal(data.state.player.score, 110);
    assert.equal(data.state.config.teamAScore, 150);
  });

  test('enforces TEAM + MISSION duplicate scope and allows the other team independently', async () => {
    const data = fixture();
    await completeMissionForPlayer('uid-a', 'mission-1', data.store, fixedRuntime());
    await rejectsWith('ALREADY_COMPLETED', () => completeMissionForPlayer(
      'uid-a', 'mission-1', data.store, fixedRuntime(),
    ));
    assert.equal(data.state.player.score, 35);
    assert.equal(data.state.config.teamAScore, 75);

    data.state.player = {
      name: 'Runner A2', team: 'A', status: 'ACTIVE', score: 0, invincibleCards: 0,
    };
    await rejectsWith('ALREADY_COMPLETED', () => completeMissionForPlayer(
      'uid-a2', 'mission-1', data.store, fixedRuntime(),
    ));

    data.state.player = {
      name: 'Runner B', team: 'B', status: 'ACTIVE', score: 0, invincibleCards: 0,
    };
    const otherTeam = await completeMissionForPlayer(
      'uid-b', 'mission-1', data.store, fixedRuntime(),
    );
    assert.equal(otherTeam.ok, true);
    assert.equal(data.state.config.teamBScore, 85);
    assert.equal(data.state.writes.length, 2);
    assert.notEqual(
      data.state.writes[0].completionId,
      data.state.writes[1].completionId,
    );
  });

  test('uses Game Core Lucky boundaries and persists the matching card delta', async () => {
    for (const [randomValue, lucky] of [
      [0, true],
      [0.1, true],
      [0.199999, true],
      [0.2, false],
    ]) {
      const data = fixture();
      const result = await completeMissionForPlayer(
        'uid-a', 'mission-1', data.store, fixedRuntime(randomValue),
      );
      assert.equal(result.score.luckyReward, lucky);
      assert.equal(result.score.invincibleCardDelta, lucky ? 1 : 0);
      assert.equal(data.state.player.invincibleCards, lucky ? 3 : 2);
    }
  });

  test('writes the completion record and MISSION log from trusted state', async () => {
    const data = fixture({ config: { ...fixture().state.config, logs: Array.from(
      { length: 201 }, (_, index) => ({ id: `old-${index}`, type: 'SYSTEM' }),
    ) } });
    const missionBefore = structuredClone(data.state.mission);
    const playerIdentityBefore = {
      name: data.state.player.name,
      team: data.state.player.team,
      status: data.state.player.status,
    };
    await completeMissionForPlayer('uid-a', 'mission-1', data.store, fixedRuntime(0.1));

    const write = data.state.writes[0];
    assert.deepEqual(write.completion, {
      missionId: 'mission-1',
      team: 'A',
      completedBy: 'uid-a',
      points: 25,
      luckyReward: true,
      isFinalMission: false,
    });
    assert.equal(write.completionId, createMissionCompletionId('A', 'mission-1'));
    assert.equal(write.logs.length, 200);
    assert.equal(write.logs[0].type, 'MISSION');
    assert.equal(write.logs[0].timestamp, 1_700_000_000_000);
    assert.match(write.logs[0].message, /Runner A/);
    assert.match(write.logs[0].message, /Team A/);
    assert.match(write.logs[0].message, /\+25pt/);
    assert.match(write.logs[0].message, /LUCKY/);
    assert.deepEqual(data.state.mission, missionBefore);
    assert.deepEqual({
      name: data.state.player.name,
      team: data.state.player.team,
      status: data.state.player.status,
    }, playerIdentityBefore);
  });

  test('completion ids are deterministic, team-scoped, and slash-safe', () => {
    const idA = createMissionCompletionId('A', 'mission/with/slashes');
    assert.equal(idA, createMissionCompletionId('A', 'mission/with/slashes'));
    assert.notEqual(idA, createMissionCompletionId('B', 'mission/with/slashes'));
    assert.doesNotMatch(idA, /\//);
  });

  test('generates random and clock values once outside transaction retries', async () => {
    const writes = [];
    const data = fixture();
    const retryingStore = {
      async runTransaction(work) {
        let result;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let write;
          result = await work({
            readPlayer: async () => data.state.player,
            readGameConfig: async () => data.state.config,
            readMission: async () => data.state.mission,
            readCompletion: async () => false,
            writeMissionCompletion: value => { write = structuredClone(value); },
          });
          writes.push(write);
        }
        return result;
      },
    };
    const runtime = fixedRuntime(0.1, 1_700_000_123_000);

    const result = await completeMissionForPlayer(
      'uid-a', 'mission-1', retryingStore, runtime,
    );
    assert.equal(result.score.luckyReward, true);
    assert.deepEqual(runtime.calls(), { randomCalls: 1, nowCalls: 1 });
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(writes[0].logs[0].timestamp, 1_700_000_123_000);
  });

  test('maps storage failures to a persistence error', async () => {
    const brokenStore = { runTransaction: async () => { throw new Error('internal path leaked'); } };
    await rejectsWith('PERSISTENCE_ERROR', () => completeMissionForPlayer(
      'uid-a', 'mission-1', brokenStore, fixedRuntime(),
    ));
  });
});
