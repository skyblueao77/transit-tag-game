import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  processWaitingLifecycle,
  processWaitingLifecycleForPlayer,
  resumeWaitingForPlayer,
  startWaitingForPlayer,
  WaitingServiceError,
} from '../lib/functions/src/waiting/waitingService.js';
import {
  SHINKANSEN_LIMIT_DURATION_MS,
  SHINKANSEN_WAIT_DURATION_MS,
} from '../../src/game/time.ts';

const now = 1_800_000_000_000;

function basePlayer(overrides = {}) {
  return {
    id: 'uid-a', name: 'Trusted Player', team: 'A', status: 'ACTIVE',
    waitingUntil: 0, shinkansenStartTime: null, score: 81,
    invincibleCards: 3, invincibleUntil: 0,
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    gameStatus: 'DAY1_ACTIVE', teamARole: 'RUNNER', teamBRole: 'ONI',
    teamAScore: 20, teamBScore: 30, logs: [], ...overrides,
  };
}

function fixture({ player = basePlayer(), config = baseConfig() } = {}) {
  const state = { player, config, writes: [], events: [] };
  const store = {
    async runTransaction(work) {
      const pending = [];
      const transaction = {
        readPlayer: async uid => {
          state.events.push('read-player');
          return state.player ? { id: 'uid-a', data: state.player } : null;
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
    async listParticipantIds() { return ['uid-a']; },
  };
  return { state, store };
}

function runtime(timestamp = now) {
  let nowCalls = 0;
  let idCalls = 0;
  return {
    now: () => { nowCalls += 1; return timestamp; },
    createLogId: () => { idCalls += 1; return 'server-log-id'; },
    calls: () => ({ nowCalls, idCalls }),
  };
}

async function rejectsWithoutWrites(reason, data) {
  const { state, store } = fixture(data);
  await assert.rejects(startWaitingForPlayer('uid-a', store, runtime()), error => {
    assert.ok(error instanceof WaitingServiceError);
    assert.equal(error.reason, reason);
    return true;
  });
  assert.equal(state.writes.length, 0);
}

describe('server Waiting service', () => {
  test('rejects missing Player and Game Config with zero writes', async () => {
    await rejectsWithoutWrites('PLAYER_NOT_FOUND', { player: null });
    await rejectsWithoutWrites('CONFIG_NOT_FOUND', { config: null });
  });

  test('rejects malformed identity/team/status/timestamps and invalid participant boundary', async () => {
    await rejectsWithoutWrites('INVALID_TEAM', { player: basePlayer({ team: 'ADMIN' }) });
    await rejectsWithoutWrites('INVALID_TEAM', { player: basePlayer({ team: 'unknown' }) });
    await rejectsWithoutWrites('INVALID_TEAM', { player: basePlayer({ team: undefined }) });
    for (const overrides of [
      { id: 'another-uid' },
      { status: 'UNKNOWN' },
      { status: undefined },
      { waitingUntil: 'later' },
      { waitingUntil: Number.NaN },
      { shinkansenStartTime: 'later' },
      { shinkansenStartTime: Number.POSITIVE_INFINITY },
      { name: '' },
    ]) {
      await rejectsWithoutWrites('INVALID_PLAYER_STATE', { player: basePlayer(overrides) });
    }
  });

  test('rejects ONI, non-ACTIVE, paused/invalid phase, malformed config, and already Waiting', async () => {
    await rejectsWithoutWrites('WRONG_ROLE', {
      config: baseConfig({ teamARole: 'ONI' }),
    });
    await rejectsWithoutWrites('INVALID_STATUS', {
      player: basePlayer({ status: 'WAITING', waitingUntil: now + 1000 }),
    });
    await rejectsWithoutWrites('INVALID_STATUS', {
      player: basePlayer({ status: 'RETIRED' }),
    });
    await rejectsWithoutWrites('PHASE', { config: baseConfig({ gameStatus: 'DAY1_PAUSED' }) });
    await rejectsWithoutWrites('PHASE', { config: baseConfig({ gameStatus: 'PRE_GAME' }) });
    await rejectsWithoutWrites('INVALID_GAME_CONFIG', { config: baseConfig({ teamARole: 'ADMIN' }) });
    await rejectsWithoutWrites('INVALID_GAME_CONFIG', { config: baseConfig({ logs: 'invalid' }) });
  });

  test('starts Waiting in each allowed phase with a fixed deadline and atomic trusted log', async () => {
    for (const gameStatus of ['DAY1_ACTIVE', 'DAY2_ACTIVE', 'FINAL_MISSION']) {
      const oldLogs = Array.from({ length: 205 }, (_, index) => ({ id: `old-${index}` }));
      const { state, store } = fixture({ config: baseConfig({ gameStatus, logs: oldLogs }) });
      const clock = runtime();
      const before = structuredClone(state.player);
      const result = await startWaitingForPlayer('uid-a', store, clock);

      assert.deepEqual(result, {
        ok: true,
        waitingUntil: now + SHINKANSEN_WAIT_DURATION_MS,
        duration: SHINKANSEN_WAIT_DURATION_MS,
      });
      assert.equal(state.player.status, 'WAITING');
      assert.equal(state.player.waitingUntil, now + SHINKANSEN_WAIT_DURATION_MS);
      assert.equal(state.player.shinkansenStartTime, null);
      assert.equal(state.player.score, before.score);
      assert.equal(state.player.invincibleCards, before.invincibleCards);
      assert.equal(state.player.invincibleUntil, before.invincibleUntil);
      assert.equal(state.writes.length, 2);
      assert.deepEqual(state.events, ['read-player', 'read-config', 'write-player', 'write-logs']);
      assert.equal(state.config.logs.length, 200);
      assert.deepEqual(state.config.logs[1], oldLogs[0]);
      assert.deepEqual(state.config.logs[0], {
        id: 'server-log-id',
        timestamp: now,
        message: `${new Date(now).toLocaleTimeString('ja-JP', {
          timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit',
        })} Team A Trusted Player が新幹線待機を開始 (60分)`,
        type: 'SYSTEM',
      });
      assert.deepEqual(clock.calls(), { nowCalls: 1, idCalls: 1 });
    }
  });

  test('retries use the same server clock and log identity', async () => {
    const { state } = fixture();
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
    const clock = runtime();
    await startWaitingForPlayer('uid-a', retryingStore, clock);
    assert.deepEqual(clock.calls(), { nowCalls: 1, idCalls: 1 });
    assert.deepEqual(attemptWrites[0], attemptWrites[1]);
    assert.equal(attemptWrites[0][1][1][0].timestamp, now);
    assert.equal(attemptWrites[0][1][1][0].id, 'server-log-id');
  });

  test('resumes at deadline, normalizes fields, and is idempotent when already ACTIVE', async () => {
    const { state, store } = fixture({
      player: basePlayer({ status: 'WAITING', waitingUntil: now, shinkansenStartTime: now - 1 }),
    });
    assert.deepEqual(await resumeWaitingForPlayer('uid-a', store, runtime()), { ok: true, resumed: true });
    assert.equal(state.player.status, 'ACTIVE');
    assert.equal(state.player.waitingUntil, 0);
    assert.equal(state.player.shinkansenStartTime, null);
    assert.equal(state.writes.length, 1);

    const again = await resumeWaitingForPlayer('uid-a', store, runtime());
    assert.deepEqual(again, { ok: true, resumed: false });
    assert.equal(state.writes.length, 1);
  });

  test('rejects early, non-WAITING, and malformed deadline resumes without writes', async () => {
    for (const [player, reason] of [
      [basePlayer({ status: 'WAITING', waitingUntil: now + 1 }), 'WAITING_NOT_EXPIRED'],
      [basePlayer({ status: 'ACTIVE' }), null],
      [basePlayer({ status: 'WAITING', waitingUntil: 0 }), 'INVALID_WAITING_DEADLINE'],
      [basePlayer({ status: 'EMERGENCY', waitingUntil: now }), 'NOT_WAITING'],
      [basePlayer({ status: 'RETIRED', waitingUntil: now }), 'NOT_WAITING'],
    ]) {
      const { state, store } = fixture({ player });
      if (reason === null) {
        assert.deepEqual(await resumeWaitingForPlayer('uid-a', store, runtime()), { ok: true, resumed: false });
      } else {
        await assert.rejects(resumeWaitingForPlayer('uid-a', store, runtime()), error => error.reason === reason);
      }
      assert.equal(state.writes.length, 0);
    }
  });

  test('scheduled processing resumes expired Waiting and skips future, Emergency, Retired, and malformed records', async () => {
    const fixtures = new Map([
      ['expired', fixture({ player: basePlayer({ id: 'expired', status: 'WAITING', waitingUntil: now }) })],
      ['future', fixture({ player: basePlayer({ id: 'future', status: 'WAITING', waitingUntil: now + 1 }) })],
      ['emergency', fixture({ player: basePlayer({ id: 'emergency', status: 'EMERGENCY' }) })],
      ['retired', fixture({ player: basePlayer({ id: 'retired', status: 'RETIRED' }) })],
      ['malformed', fixture({ player: basePlayer({ id: 'malformed', status: 'WAITING', waitingUntil: 'bad' }) })],
      ['train', fixture({ player: basePlayer({ id: 'train', shinkansenStartTime: now - SHINKANSEN_LIMIT_DURATION_MS - 1 }) })],
      ['not-overdue', fixture({ player: basePlayer({ id: 'not-overdue', shinkansenStartTime: now - SHINKANSEN_LIMIT_DURATION_MS }) })],
    ]);
    const store = {
      listParticipantIds: async () => [...fixtures.keys()],
      async runTransaction(work) {
        let selected;
        const pending = [];
        const result = await work({
          readPlayer: async uid => {
            selected = fixtures.get(uid);
            return selected
              ? { id: selected.state.player.id, data: selected.state.player }
              : null;
          },
          readGameConfig: async () => selected.state.config,
          writePlayer: (uid, updates) => pending.push(['player', structuredClone(updates)]),
          writeLogs: logs => pending.push(['logs', structuredClone(logs)]),
        });
        for (const [kind, value] of pending) {
          if (kind === 'player') Object.assign(selected.state.player, value);
          else selected.state.config.logs = value;
          selected.state.writes.push([kind, value]);
        }
        return result;
      },
    };

    const result = await processWaitingLifecycle(store, runtime());
    assert.deepEqual(result, {
      scanned: 7,
      resumed: 1,
      shinkansenWaiting: 1,
      skipped: 5,
      skippedReasons: {
        WAITING_NOT_EXPIRED: 1,
        NOT_ACTIVE: 2,
        INVALID_PLAYER_STATE: 1,
        SHINKANSEN_LIMIT_NOT_REACHED: 1,
      },
      skippedPlayers: [
        { uid: 'future', reason: 'WAITING_NOT_EXPIRED' },
        { uid: 'emergency', reason: 'NOT_ACTIVE' },
        { uid: 'retired', reason: 'NOT_ACTIVE' },
        { uid: 'malformed', reason: 'INVALID_PLAYER_STATE' },
        { uid: 'not-overdue', reason: 'SHINKANSEN_LIMIT_NOT_REACHED' },
      ],
    });
    assert.equal(fixtures.get('expired').state.player.status, 'ACTIVE');
    assert.equal(fixtures.get('future').state.player.status, 'WAITING');
    assert.equal(fixtures.get('emergency').state.player.status, 'EMERGENCY');
    assert.equal(fixtures.get('retired').state.player.status, 'RETIRED');
    assert.equal(fixtures.get('train').state.player.status, 'WAITING');
    assert.equal(fixtures.get('train').state.player.waitingUntil, now + SHINKANSEN_WAIT_DURATION_MS);
    assert.equal(fixtures.get('train').state.player.shinkansenStartTime, null);
    assert.equal(fixtures.get('train').state.config.logs.length, 1);
    assert.equal(fixtures.get('train').state.config.logs[0].timestamp, now);
  });

  test('continues processing later Players after one scheduled transaction fails', async () => {
    const good = fixture({ player: basePlayer({ status: 'WAITING', waitingUntil: now }) });
    const store = {
      listParticipantIds: async () => ['broken', 'uid-a'],
      runTransaction: work => work({
        readPlayer: async uid => {
          if (uid === 'broken') throw new Error('storage unavailable for one Player');
          return { id: uid, data: good.state.player };
        },
        readGameConfig: async () => good.state.config,
        writePlayer: (uid, updates) => Object.assign(good.state.player, updates),
        writeLogs: logs => { good.state.config.logs = logs; },
      }),
    };
    const result = await processWaitingLifecycle(store, runtime());
    assert.equal(result.scanned, 2);
    assert.equal(result.resumed, 1);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.skippedReasons, { PERSISTENCE_ERROR: 1 });
    assert.deepEqual(result.skippedPlayers, [{ uid: 'broken', reason: 'PERSISTENCE_ERROR' }]);
    assert.equal(good.state.player.status, 'ACTIVE');
  });

  test('maps storage failures without returning successful mutations', async () => {
    const store = { runTransaction: async () => { throw new Error('private Firestore error'); } };
    await assert.rejects(startWaitingForPlayer('uid-a', store, runtime()), error => {
      assert.equal(error.reason, 'PERSISTENCE_ERROR');
      return true;
    });
  });
});
