import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  activateInvincibilityForPlayer as activateInvincibilityService,
  InvincibilityServiceError,
} from '../lib/functions/src/powerup/invincibilityService.js';
import { INVINCIBILITY_DURATION_MS } from '../../src/game/time.ts';

const fixedNow = 1_700_000_000_000;
const sessionId = 'session_powerup_2';
function activateInvincibilityForPlayer(uid, store, runtime) {
  return activateInvincibilityService(uid, sessionId, store, runtime);
}

function basePlayer(overrides = {}) {
  return {
    id: 'uid-a',
    name: 'Trusted Runner',
    team: 'A',
    status: 'ACTIVE',
    score: 72,
    invincibleCards: 2,
    invincibleUntil: 0,
    waitingUntil: 1_700_000_500_000,
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    gameSessionId: sessionId, sessionStartedAt: fixedNow, sessionSchemaVersion: 2,
    gameStatus: 'DAY1_ACTIVE',
    teamARole: 'RUNNER',
    teamBRole: 'ONI',
    teamAScore: 20,
    teamBScore: 30,
    logs: [],
    ...overrides,
  };
}

function fixture({ player = basePlayer(), config = baseConfig() } = {}) {
  const state = { player, config, writes: [], reads: [] };
  const store = {
    async runTransaction(work) {
      let pendingWrite;
      const transaction = {
        readPlayer: async () => { state.reads.push('player'); return state.player; },
        readGameConfig: async () => { state.reads.push('config'); return state.config; },
        writeInvincibility: write => { state.reads.push('write'); pendingWrite = structuredClone(write); },
      };
      const result = await work(transaction);
      if (pendingWrite) {
        state.writes.push(pendingWrite);
        state.player.invincibleCards = pendingWrite.invincibleCards;
        state.player.invincibleUntil = pendingWrite.invincibleUntil;
        state.config.logs = pendingWrite.logs;
      }
      return result;
    },
  };
  return { state, store };
}

function fixedRuntime(now = fixedNow, id = 'server-log-id') {
  let nowCalls = 0;
  let idCalls = 0;
  return {
    now: () => { nowCalls += 1; return now; },
    createLogId: () => { idCalls += 1; return id; },
    calls: () => ({ nowCalls, idCalls }),
  };
}

async function rejectsWith(reason, callback, domainReason) {
  await assert.rejects(callback, error => {
    assert.ok(error instanceof InvincibilityServiceError);
    assert.equal(error.reason, reason);
    if (domainReason !== undefined) assert.equal(error.domainReason, domainReason);
    return true;
  });
}

async function assertRejectedWithoutWrites(reason, data, domainReason) {
  const { state, store } = fixture(data);
  await rejectsWith(reason, () => activateInvincibilityForPlayer(
    'uid-a', store, fixedRuntime(),
  ), domainReason);
  assert.equal(state.writes.length, 0);
}

describe('server invincibility service', () => {
  test('rejects missing player or game config without authoritative writes', async () => {
    await assertRejectedWithoutWrites('PLAYER_NOT_FOUND', { player: null });
    await assertRejectedWithoutWrites('CONFIG_NOT_FOUND', { config: null });
  });

  test('rejects missing, malformed, stale, or invalid Config Sessions before Player reads or writes', async () => {
    for (const expectedSessionId of [undefined, '', 'bad/session', 7]) {
      const { state, store } = fixture();
      await rejectsWith('SESSION_CHANGED', () => activateInvincibilityService(
        'uid-a', expectedSessionId, store, fixedRuntime(),
      ));
      assert.deepEqual(state.reads, []);
      assert.equal(state.writes.length, 0);
    }

    for (const config of [
      baseConfig({ gameSessionId: undefined }),
      baseConfig({ gameSessionId: 'bad/session' }),
      baseConfig({ sessionStartedAt: undefined }),
      baseConfig({ sessionSchemaVersion: 1 }),
    ]) {
      const { state, store } = fixture({ config });
      await rejectsWith('SESSION_CHANGED', () => activateInvincibilityForPlayer('uid-a', store, fixedRuntime()));
      assert.deepEqual(state.reads, ['config']);
      assert.equal(state.writes.length, 0);
    }

    const stale = fixture();
    await rejectsWith('SESSION_CHANGED', () => activateInvincibilityService(
      'uid-a', 'session_stale', stale.store, fixedRuntime(),
    ));
    assert.deepEqual(stale.state.reads, ['config']);
    assert.equal(stale.state.writes.length, 0);

    const missingConfig = fixture({ config: null });
    await rejectsWith('CONFIG_NOT_FOUND', () => activateInvincibilityForPlayer(
      'uid-a', missingConfig.store, fixedRuntime(),
    ));
    assert.deepEqual(missingConfig.state.reads, ['config']);
    assert.equal(missingConfig.state.writes.length, 0);
  });

  test('rejects malformed identity, participant team, status, cards, and deadline without writes', async () => {
    const malformedPlayers = [
      [{ id: 'other-uid' }, 'INVALID_PLAYER_STATE'],
      [{ team: 'ADMIN' }, 'INVALID_PLAYER_STATE'],
      [{ team: 'C' }, 'INVALID_PLAYER_STATE'],
      [{ team: undefined }, 'INVALID_PLAYER_STATE'],
      [{ status: 'UNKNOWN' }, 'INVALID_PLAYER_STATE'],
      [{ status: undefined }, 'INVALID_PLAYER_STATE'],
      [{ invincibleCards: 1.5 }, 'INVALID_PLAYER_STATE'],
      [{ invincibleCards: Number.NaN }, 'INVALID_PLAYER_STATE'],
      [{ invincibleCards: -1 }, 'INVALID_PLAYER_STATE'],
      [{ invincibleCards: undefined }, 'INVALID_PLAYER_STATE'],
      [{ invincibleUntil: Number.POSITIVE_INFINITY }, 'INVALID_PLAYER_STATE'],
      [{ invincibleUntil: 'tomorrow' }, 'INVALID_PLAYER_STATE'],
      [{ invincibleUntil: -1 }, 'INVALID_PLAYER_STATE'],
      [{ name: '' }, 'INVALID_PLAYER_STATE'],
    ];
    for (const [playerOverrides, reason] of malformedPlayers) {
      await assertRejectedWithoutWrites(reason, { player: basePlayer(playerOverrides) });
    }
  });

  test('rejects non-ACTIVE player statuses without writes', async () => {
    for (const status of ['WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED']) {
      await assertRejectedWithoutWrites('POWERUP_NOT_ALLOWED', {
        player: basePlayer({ status }),
      });
    }
  });

  test('rejects malformed game config without writes', async () => {
    for (const config of [
      baseConfig({ gameStatus: 'UNKNOWN' }),
      baseConfig({ gameStatus: undefined }),
      baseConfig({ teamARole: 'ADMIN' }),
      baseConfig({ teamBRole: undefined }),
      baseConfig({ logs: 'not-an-array' }),
    ]) {
      await assertRejectedWithoutWrites('INVALID_GAME_CONFIG', { config });
    }
  });

  test('maps Core role, card, phase, and active-deadline rejections without writes', async () => {
    await assertRejectedWithoutWrites('WRONG_ROLE', {
      config: baseConfig({ teamARole: 'ONI' }),
    });
    await assertRejectedWithoutWrites('NO_CARDS', {
      player: basePlayer({ invincibleCards: 0 }),
    });
    await assertRejectedWithoutWrites('POWERUP_NOT_ALLOWED', {
      config: baseConfig({ gameStatus: 'DAY1_PAUSED' }),
    }, 'PHASE');
    await assertRejectedWithoutWrites('ALREADY_ACTIVE', {
      player: basePlayer({ invincibleUntil: fixedNow + 1 }),
    });
  });

  test('activates in each Core-approved phase using the exact Core result', async () => {
    for (const gameStatus of ['DAY1_ACTIVE', 'DAY2_ACTIVE', 'FINAL_MISSION']) {
      const { state, store } = fixture({ config: baseConfig({ gameStatus }) });
      const before = structuredClone({ player: state.player, config: state.config });
      const result = await activateInvincibilityForPlayer('uid-a', store, fixedRuntime());

      assert.deepEqual(result, {
        ok: true,
        remainingCards: 1,
        invincibleUntil: fixedNow + INVINCIBILITY_DURATION_MS,
        duration: INVINCIBILITY_DURATION_MS,
      });
      assert.equal(state.writes.length, 1);
      assert.equal(state.player.invincibleCards, 1);
      assert.equal(state.player.invincibleUntil, fixedNow + INVINCIBILITY_DURATION_MS);
      assert.equal(state.player.score, before.player.score);
      assert.equal(state.player.status, before.player.status);
      assert.equal(state.player.waitingUntil, before.player.waitingUntil);
      assert.equal(state.config.teamAScore, before.config.teamAScore);
      assert.equal(state.config.teamBScore, before.config.teamBScore);
    }
  });

  test('writes a trusted SYSTEM log and caps logs at 200', async () => {
    const oldLogs = Array.from({ length: 205 }, (_, index) => ({ id: `old-${index}` }));
    const { state, store } = fixture({
      player: basePlayer({ name: 'Firestore Name', team: 'B' }),
      config: baseConfig({
        teamARole: 'ONI',
        teamBRole: 'RUNNER',
        logs: oldLogs,
      }),
    });
    const before = structuredClone({ player: state.player, logs: state.config.logs });
    await activateInvincibilityForPlayer('uid-a', store, fixedRuntime());

    const write = state.writes[0];
    assert.equal(write.playerId, 'uid-a');
    assert.equal(write.invincibleCards, 1);
    assert.equal(write.invincibleUntil, fixedNow + INVINCIBILITY_DURATION_MS);
    assert.equal(write.logs.length, 200);
    assert.deepEqual(write.logs[0], {
      id: 'server-log-id',
      timestamp: fixedNow,
      message: `${new Date(fixedNow).toLocaleTimeString('ja-JP', {
        timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit',
      })} Team B Firestore Name が無敵カードを使用`,
      type: 'SYSTEM',
    });
    assert.equal(write.logs[1].id, 'old-0');
    assert.equal(state.player.name, before.player.name);
    assert.equal(state.player.team, before.player.team);
    assert.equal(state.config.logs.length, 200);
  });

  test('reads both trusted documents before the only transaction write', async () => {
    const events = [];
    const store = {
      runTransaction: work => work({
        readPlayer: async () => { events.push('player-read'); return basePlayer(); },
        readGameConfig: async () => { events.push('config-read'); return baseConfig(); },
        writeInvincibility: () => events.push('write'),
      }),
    };
    await activateInvincibilityForPlayer('uid-a', store, fixedRuntime());
    assert.deepEqual(events, ['config-read', 'player-read', 'write']);
  });

  test('obtains clock and log id once outside retryable transaction work', async () => {
    const data = fixture();
    const attemptWrites = [];
    const retryingStore = {
      async runTransaction(work) {
        let result;
        for (let index = 0; index < 2; index += 1) {
          let pendingWrite;
          result = await work({
            readPlayer: async () => data.state.player,
            readGameConfig: async () => data.state.config,
            writeInvincibility: write => { pendingWrite = structuredClone(write); },
          });
          attemptWrites.push(pendingWrite);
        }
        return result;
      },
    };
    const runtime = fixedRuntime();
    await activateInvincibilityForPlayer('uid-a', retryingStore, runtime);

    assert.deepEqual(runtime.calls(), { nowCalls: 1, idCalls: 1 });
    assert.deepEqual(attemptWrites[0], attemptWrites[1]);
    assert.equal(attemptWrites[0].logs[0].timestamp, fixedNow);
    assert.equal(attemptWrites[0].logs[0].id, 'server-log-id');
  });

  test('maps transaction failures without returning success', async () => {
    const store = { runTransaction: async () => { throw new Error('private Firestore path'); } };
    await rejectsWith('PERSISTENCE_ERROR', () => activateInvincibilityForPlayer(
      'uid-a', store, fixedRuntime(),
    ));
  });
});
