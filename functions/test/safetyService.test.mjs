import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  requestSafetyActionForPlayer,
  SafetyServiceError,
} from '../lib/functions/src/safety/safetyService.js';

const now = 1_800_000_000_000;

function basePlayer(overrides = {}) {
  return {
    id: 'uid-a', name: 'Trusted Player', team: 'A', status: 'ACTIVE',
    waitingUntil: 0, shinkansenStartTime: null, invincibleUntil: 123,
    invincibleCards: 2, score: 47, ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return { gameStatus: 'GAME_OVER', logs: [], ...overrides };
}

function fixture({ player = basePlayer(), config = baseConfig(), documentId = 'uid-a' } = {}) {
  const state = { player, config, documentId, writes: [], events: [] };
  const store = {
    async runTransaction(work) {
      const pending = [];
      const transaction = {
        readPlayer: async uid => {
          state.events.push('read-player');
          return state.player ? { id: state.documentId, data: state.player } : null;
        },
        readGameConfig: async () => { state.events.push('read-config'); return state.config; },
        writePlayer: (uid, updates) => { state.events.push('write-player'); pending.push(['player', uid, structuredClone(updates)]); },
        writeLogs: logs => { state.events.push('write-logs'); pending.push(['logs', structuredClone(logs)]); },
      };
      const result = await work(transaction);
      for (const write of pending) {
        state.writes.push(write);
        if (write[0] === 'player') Object.assign(state.player, write[2]);
        else state.config.logs = write[1];
      }
      return result;
    },
  };
  return { state, store };
}

function runtime(timestamp = now) {
  let nowCalls = 0;
  let idCalls = 0;
  return {
    now: () => { nowCalls += 1; return timestamp; },
    createLogId: () => { idCalls += 1; return 'server-safety-log'; },
    calls: () => ({ nowCalls, idCalls }),
  };
}

async function rejectsWithoutWrites(reason, options, request = { action: 'EMERGENCY', reasonCode: 'OTHER' }) {
  const { state, store } = fixture(options);
  await assert.rejects(requestSafetyActionForPlayer('uid-a', request, store, runtime()), error => {
    assert.ok(error instanceof SafetyServiceError);
    assert.equal(error.reason, reason);
    return true;
  });
  assert.equal(state.writes.length, 0);
}

describe('server Safety Action service', () => {
  test('rejects missing Player/Config, identity, participant, and malformed Player fields without writes', async () => {
    await rejectsWithoutWrites('PLAYER_NOT_FOUND', { player: null });
    await rejectsWithoutWrites('CONFIG_NOT_FOUND', { config: null });
    await rejectsWithoutWrites('INVALID_PLAYER_STATE', { documentId: 'other-id' });
    await rejectsWithoutWrites('INVALID_PLAYER_STATE', { player: basePlayer({ id: 'other-id' }) });
    await rejectsWithoutWrites('INVALID_PLAYER_STATE', { player: basePlayer({ name: '' }) });
    await rejectsWithoutWrites('INVALID_TEAM', { player: basePlayer({ team: 'ADMIN' }) });
    await rejectsWithoutWrites('INVALID_TEAM', { player: basePlayer({ team: 'unknown' }) });

    for (const overrides of [
      { status: 'UNKNOWN' }, { status: undefined },
      { waitingUntil: 'later' }, { waitingUntil: Number.NaN },
      { shinkansenStartTime: 'later' }, { shinkansenStartTime: Number.POSITIVE_INFINITY },
      { invincibleUntil: 'later' }, { invincibleUntil: Number.NaN },
      { invincibleCards: -1 }, { invincibleCards: 1.5 }, { invincibleCards: undefined },
      { score: Number.NaN },
    ]) {
      await rejectsWithoutWrites('INVALID_PLAYER_STATE', { player: basePlayer(overrides) });
    }
    await rejectsWithoutWrites('INVALID_GAME_CONFIG', { config: baseConfig({ logs: 'invalid' }) });
  });

  test('rejects malformed requests and action/reason mismatches with zero writes', async () => {
    for (const request of [null, [], 'x', {}, { action: 'UNKNOWN', reasonCode: 'OTHER' },
      { action: 'EMERGENCY' }, { action: 'EMERGENCY', reasonCode: 'OTHER', message: 'extra' },
      { action: 'EMERGENCY', reasonCode: 'RETIREMENT_REQUEST' },
      { action: 'RETIRE', reasonCode: 'OTHER' },
      { action: 'RETIRE', reasonCode: 'RETIREMENT_REQUEST', playerId: 'x' }]) {
      const { state, store } = fixture();
      await assert.rejects(requestSafetyActionForPlayer('uid-a', request, store, runtime()), SafetyServiceError);
      assert.equal(state.writes.length, 0);
    }
  });

  test('transitions ACTIVE/WAITING/CAPTURED into Emergency and Retired atomically', async () => {
    for (const [status, action, reasonCode, nextStatus, label] of [
      ['ACTIVE', 'EMERGENCY', 'ILLNESS_OR_INJURY', 'EMERGENCY', '急病・怪我'],
      ['WAITING', 'EMERGENCY', 'EQUIPMENT_ISSUE', 'EMERGENCY', '機材トラブル'],
      ['CAPTURED', 'EMERGENCY', 'OTHER', 'EMERGENCY', 'その他の緊急事態'],
      ['ACTIVE', 'RETIRE', 'RETIREMENT_REQUEST', 'RETIRED', 'リタイア'],
      ['WAITING', 'RETIRE', 'RETIREMENT_REQUEST', 'RETIRED', 'リタイア'],
      ['CAPTURED', 'RETIRE', 'RETIREMENT_REQUEST', 'RETIRED', 'リタイア'],
      ['EMERGENCY', 'RETIRE', 'RETIREMENT_REQUEST', 'RETIRED', 'リタイア'],
    ]) {
      const waitingUntil = status === 'WAITING' ? now + 60_000 : 0;
      const { state, store } = fixture({
        player: basePlayer({ status, waitingUntil, shinkansenStartTime: now - 1, invincibleUntil: now + 30_000 }),
      });
      const before = structuredClone(state.player);
      const result = await requestSafetyActionForPlayer('uid-a', { action, reasonCode }, store, runtime());
      assert.deepEqual(result, { ok: true, changed: true, status: nextStatus });
      assert.equal(state.player.status, nextStatus);
      assert.equal(state.player.waitingUntil, 0);
      assert.equal(state.player.shinkansenStartTime, null);
      assert.equal(state.player.invincibleUntil, 0);
      assert.equal(state.player.invincibleCards, before.invincibleCards);
      assert.equal(state.player.score, before.score);
      assert.equal(state.player.team, before.team);
      assert.equal(state.writes.length, 2);
      assert.deepEqual(state.events, ['read-player', 'read-config', 'write-player', 'write-logs']);
      assert.equal(state.config.logs.length, 1);
      assert.deepEqual(state.config.logs[0], {
        id: 'server-safety-log', timestamp: now,
        message: `【緊急】Team A Trusted Player が SOS を発信: ${label}`,
        type: 'EMERGENCY',
      });
    }
  });

  test('same-action requests are no-op and do not update Player or Config', async () => {
    for (const [status, request] of [
      ['EMERGENCY', { action: 'EMERGENCY', reasonCode: 'OTHER' }],
      ['RETIRED', { action: 'RETIRE', reasonCode: 'RETIREMENT_REQUEST' }],
    ]) {
      const { state, store } = fixture({ player: basePlayer({ status }), config: baseConfig({ logs: [{ id: 'existing' }] }) });
      const result = await requestSafetyActionForPlayer('uid-a', request, store, runtime());
      assert.deepEqual(result, { ok: true, changed: false, status });
      assert.deepEqual(state.writes, []);
      assert.deepEqual(state.config.logs, [{ id: 'existing' }]);
    }
  });

  test('rejects Emergency after Retired and keeps Retired unchanged', async () => {
    await rejectsWithoutWrites('RETIRED_TERMINAL', { player: basePlayer({ status: 'RETIRED' }) });
  });

  test('caps log history and fixes time/id outside transaction retries', async () => {
    const oldLogs = Array.from({ length: 205 }, (_, index) => ({ id: `old-${index}` }));
    const { state, store } = fixture({ config: baseConfig({ logs: oldLogs }) });
    const clock = runtime();
    const attemptWrites = [];
    const retryingStore = {
      async runTransaction(work) {
        let result;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const pending = [];
          result = await work({
            readPlayer: async uid => ({ id: uid, data: state.player }),
            readGameConfig: async () => state.config,
            writePlayer: (uid, updates) => pending.push(['player', structuredClone(updates)]),
            writeLogs: logs => pending.push(['logs', structuredClone(logs)]),
          });
          attemptWrites.push(pending);
        }
        return result;
      },
    };
    await requestSafetyActionForPlayer('uid-a', { action: 'EMERGENCY', reasonCode: 'OTHER' }, retryingStore, clock);
    assert.deepEqual(clock.calls(), { nowCalls: 1, idCalls: 1 });
    assert.deepEqual(attemptWrites[0], attemptWrites[1]);
    assert.equal(attemptWrites[0][1][1].length, 200);
    assert.equal(attemptWrites[0][1][1][0].id, 'server-safety-log');
    assert.equal(attemptWrites[0][1][1][0].timestamp, now);
    assert.equal(state.player.status, 'ACTIVE');
    assert.equal(state.writes.length, 0);
  });

  test('storage failure is mapped to PERSISTENCE_ERROR without partial writes', async () => {
    const store = { runTransaction: async () => { throw new Error('unavailable'); } };
    await assert.rejects(requestSafetyActionForPlayer(
      'uid-a', { action: 'EMERGENCY', reasonCode: 'OTHER' }, store, runtime(),
    ), error => error.reason === 'PERSISTENCE_ERROR');
  });
});
