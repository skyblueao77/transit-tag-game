import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AdminScoreAdjustmentServiceError, adjustTeamScoreForAdmin } from '../lib/functions/src/admin/adminScoreAdjustmentService.js';

const uid = 'trusted-admin';
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const now = 1_800_000_000_000;
const request = (overrides = {}) => ({ team: 'A', delta: 5, reasonCode: 'CORRECTION', requestId, ...overrides });
function makeFixture({ admin = true, gameConfig = {}, failWrite = false } = {}) {
  const state = {
    admin,
    config: gameConfig === null ? null : structuredClone({ teamAScore: 20, teamBScore: 30, logs: [], untouched: 'preserve', ...gameConfig }),
    receipts: new Map(),
    writes: [],
    reads: [],
    failWrite,
    queue: Promise.resolve(),
  };
  const store = {
    runTransaction: async work => {
      let release;
      const previous = state.queue;
      state.queue = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        const pending = [];
        const tx = {
          readAdmin: async actor => { state.reads.push(`admin:${actor}`); return actor === uid && state.admin; },
          readReceipt: async (actor, id) => { state.reads.push('receipt'); return structuredClone(state.receipts.get(`${actor}:${id}`) ?? null); },
          readConfig: async () => { state.reads.push('config'); return structuredClone(state.config); },
          writeAdjustment: (field, score, logs, actor, id, receipt) => {
            state.writes.push('config', 'receipt');
            pending.push(() => {
              state.config = { ...state.config, [field]: score, logs: structuredClone(logs) };
              state.receipts.set(`${actor}:${id}`, structuredClone(receipt));
            });
          },
        };
        const result = await work(tx);
        if (state.failWrite && pending.length > 0) throw new Error('storage failure');
        pending.forEach(apply => apply());
        return result;
      } finally {
        release();
      }
    },
  };
  let logSequence = 0;
  const runtime = {
    calls: { now: 0, id: 0 },
    now() { this.calls.now += 1; return now; },
    createLogId() { this.calls.id += 1; logSequence += 1; return `score-log-${logSequence}`; },
  };
  return { state, store, runtime };
}
async function rejects(reason, callback) {
  await assert.rejects(callback, error => error instanceof AdminScoreAdjustmentServiceError && error.reason === reason);
}

describe('trusted Admin score adjustment service', () => {
  test('atomically adjusts only the selected score, logs trusted audit data, and stores a receipt', async () => {
    const oldLogs = Array.from({ length: 204 }, (_, index) => ({ id: `old-${index}` }));
    const f = makeFixture({ gameConfig: { logs: oldLogs, extraField: 'untouched' } });
    const result = await adjustTeamScoreForAdmin(uid, request({ team: 'B', delta: -10, reasonCode: 'PENALTY' }), f.store, f.runtime);
    assert.deepEqual(result, { ok: true, team: 'B', delta: -10, reasonCode: 'PENALTY', previousScore: 30, nextScore: 20, duplicate: false });
    assert.equal(f.state.config.teamAScore, 20);
    assert.equal(f.state.config.teamBScore, 20);
    assert.equal(f.state.config.extraField, 'untouched');
    assert.equal(f.state.config.logs.length, 200);
    assert.deepEqual(f.state.config.logs[0], {
      id: 'score-log-1', timestamp: now, type: 'SYSTEM', actorUid: uid, action: 'adjustTeamScore',
      team: 'B', previousScore: 30, delta: -10, nextScore: 20, reasonCode: 'PENALTY', reasonLabel: '運営ペナルティ',
      message: 'Team B のスコアを 30 から 20 へ補正しました（運営ペナルティ）',
    });
    const receipt = f.state.receipts.get(`${uid}:${requestId}`);
    assert.equal(receipt.createdAt, now);
    assert.equal(receipt.result.nextScore, 20);
    assert.deepEqual(f.state.writes, ['config', 'receipt']);
    assert.deepEqual(f.state.reads, [`admin:${uid}`, 'receipt', 'config']);
    assert.deepEqual(f.runtime.calls, { now: 1, id: 1 });
  });

  test('keeps fixed clock and log ID stable when a transaction callback is retried', async () => {
    const f = makeFixture();
    const initialConfig = structuredClone(f.state.config);
    const originalReceipts = new Map(f.state.receipts);
    const retryStore = {
      runTransaction: async work => {
        await f.store.runTransaction(work);
        f.state.config = structuredClone(initialConfig);
        f.state.receipts = new Map(originalReceipts);
        f.state.writes.length = 0;
        return f.store.runTransaction(work);
      },
    };
    const result = await adjustTeamScoreForAdmin(uid, request(), retryStore, f.runtime);
    assert.equal(result.nextScore, 25);
    assert.equal(f.state.config.logs[0].id, 'score-log-1');
    assert.equal(f.state.config.logs[0].timestamp, now);
    assert.deepEqual(f.runtime.calls, { now: 1, id: 1 });
    assert.equal(f.state.receipts.size, 1);
  });

  test('supports positive adjustments and a resulting score of exactly zero', async () => {
    const a = makeFixture();
    assert.equal((await adjustTeamScoreForAdmin(uid, request({ delta: 8, reasonCode: 'BONUS' }), a.store, a.runtime)).nextScore, 28);
    const b = makeFixture({ gameConfig: { teamAScore: 6 } });
    assert.equal((await adjustTeamScoreForAdmin(uid, request({ delta: -6, reasonCode: 'OTHER' }), b.store, b.runtime)).nextScore, 0);
    assert.equal(b.state.config.teamAScore, 0);
  });

  test('rejects invalid authority, request, config and below-zero result without writes', async () => {
    const invalidRequests = [
      [request({ delta: 0 }), 'INVALID_ARGUMENT'],
      [request({ delta: 1.5 }), 'INVALID_ARGUMENT'],
      [request({ delta: -1001 }), 'INVALID_ARGUMENT'],
      [request({ delta: 1001 }), 'INVALID_ARGUMENT'],
      [request({ team: 'ADMIN' }), 'INVALID_ARGUMENT'],
      [request({ reasonCode: 'CUSTOM' }), 'INVALID_ARGUMENT'],
      [request({ requestId: 'bad' }), 'INVALID_ARGUMENT'],
      [request({ adminId: uid }), 'INVALID_ARGUMENT'],
    ];
    for (const [input, reason] of invalidRequests) {
      const f = makeFixture();
      await rejects(reason, () => adjustTeamScoreForAdmin(uid, input, f.store, f.runtime));
      assert.deepEqual(f.state.writes, []);
    }
    for (const setup of [{ admin: false }, { gameConfig: null }, { gameConfig: { teamAScore: -1 } }, { gameConfig: { teamBScore: 1.5 } }]) {
      const f = makeFixture(setup);
      const reason = setup.admin === false ? 'PERMISSION_DENIED' : setup.gameConfig === null ? 'CONFIG_NOT_FOUND' : 'INVALID_CONFIG';
      await rejects(reason, () => adjustTeamScoreForAdmin(uid, request(), f.store, f.runtime));
      assert.deepEqual(f.state.writes, []);
    }
    const belowZero = makeFixture({ gameConfig: { teamAScore: 4 } });
    await rejects('SCORE_BELOW_ZERO', () => adjustTeamScoreForAdmin(uid, request({ delta: -5 }), belowZero.store, belowZero.runtime));
    assert.deepEqual(belowZero.state.writes, []);
    await rejects('UNAUTHENTICATED', () => adjustTeamScoreForAdmin('', request(), makeFixture().store, makeFixture().runtime));
  });

  test('returns a stored result for the same payload and rejects requestId reuse with changed payload', async () => {
    const f = makeFixture();
    const first = await adjustTeamScoreForAdmin(uid, request(), f.store, f.runtime);
    const replay = await adjustTeamScoreForAdmin(uid, request(), f.store, f.runtime);
    assert.deepEqual(replay, { ...first, duplicate: true });
    assert.equal(f.state.config.teamAScore, 25);
    assert.equal(f.state.config.logs.length, 1);
    assert.equal(f.state.writes.length, 2);
    for (const changed of [request({ team: 'B' }), request({ delta: 6 }), request({ reasonCode: 'BONUS' })]) {
      await rejects('REQUEST_ID_REUSED', () => adjustTeamScoreForAdmin(uid, changed, f.store, f.runtime));
    }
    assert.equal(f.state.config.teamAScore, 25);
    assert.equal(f.state.writes.length, 2);
  });

  test('serial concurrent requests apply both deltas to the latest score without lost updates', async () => {
    const f = makeFixture();
    const [one, two] = await Promise.all([
      adjustTeamScoreForAdmin(uid, request({ delta: 7 }), f.store, f.runtime),
      adjustTeamScoreForAdmin(uid, request({ delta: 9, requestId: '123e4567-e89b-42d3-a456-426614174001' }), f.store, f.runtime),
    ]);
    assert.deepEqual([one.nextScore, two.nextScore].sort((a, b) => a - b), [27, 36]);
    assert.equal(f.state.config.teamAScore, 36);
    assert.equal(f.state.config.logs.length, 2);
    assert.equal(f.state.receipts.size, 2);
  });

  test('maps persistence failures without partially applying score, log or receipt', async () => {
    const f = makeFixture({ failWrite: true });
    await rejects('PERSISTENCE_ERROR', () => adjustTeamScoreForAdmin(uid, request(), f.store, f.runtime));
    assert.equal(f.state.config.teamAScore, 20);
    assert.equal(f.state.config.logs.length, 0);
    assert.equal(f.state.receipts.size, 0);
  });
});
