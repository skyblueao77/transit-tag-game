import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AdminGameStateServiceError,
  resumePlayerForAdmin,
  swapTeamRolesForAdmin,
} from '../lib/functions/src/admin/adminGameStateService.js';

const now = 1_800_000_000_000;
const adminUid = 'admin-uid';
const requestId = '123e4567-e89b-42d3-a456-426614174000';

function player(id, team = 'A', status = 'ACTIVE', extra = {}) {
  return {
    id, name: `Player ${id}`, team, status,
    waitingUntil: 0, shinkansenStartTime: null, invincibleUntil: 1234,
    invincibleCards: 3, score: 20, ...extra,
  };
}

function config(overrides = {}) {
  return {
    teamARole: 'ONI', teamBRole: 'RUNNER', nextRevealTime: 0,
    logs: [], teamAScore: 40, teamBScore: 50, ...overrides,
  };
}

function fixture({ users = [], gameConfig = config(), admin = true } = {}) {
  const state = {
    users: new Map(users.map(value => [value.id, structuredClone(value)])),
    config: gameConfig === null ? null : structuredClone(gameConfig),
    admins: new Set(admin ? [adminUid] : []),
    receipts: new Map(),
    writes: [],
    reads: [],
  };
  const store = {
    async runTransaction(work) {
      const pending = [];
      const tx = {
        readAdmin: async uid => { state.reads.push(`admin:${uid}`); return state.admins.has(uid); },
        readRoleSwapReceipt: async (uid, key) => {
          state.reads.push(`receipt:${uid}:${key}`);
          const value = state.receipts.get(`${uid}/${key}`);
          return value ? structuredClone(value) : null;
        },
        readGameConfig: async () => { state.reads.push('config'); return state.config && structuredClone(state.config); },
        readParticipantRoster: async () => {
          state.reads.push('roster');
          return [...state.users.values()]
            .filter(value => value.team === 'A' || value.team === 'B')
            .map(value => ({ id: value.id, data: structuredClone(value) }));
        },
        readPlayer: async id => {
          state.reads.push(`player:${id}`);
          const value = state.users.get(id);
          return value ? { id, data: structuredClone(value) } : null;
        },
        writeRoleSwap: (uid, nextConfig, changes, logs, receipt) => pending.push({
          kind: 'swap', uid, nextConfig: structuredClone(nextConfig),
          changes: structuredClone(changes), logs: structuredClone(logs), receipt: structuredClone(receipt),
        }),
        writePlayer: (id, updates) => pending.push({ kind: 'player', id, updates: structuredClone(updates) }),
        writeLogs: logs => pending.push({ kind: 'logs', logs: structuredClone(logs) }),
      };
      const result = await work(tx);
      for (const write of pending) {
        state.writes.push(write);
        if (write.kind === 'swap') {
          Object.assign(state.config, write.nextConfig, { logs: write.logs });
          for (const change of write.changes) Object.assign(state.users.get(change.playerId), change.updates);
          state.receipts.set(`${write.uid}/${write.receipt.requestId}`, write.receipt);
        } else if (write.kind === 'player') {
          Object.assign(state.users.get(write.id), write.updates);
        } else {
          state.config.logs = write.logs;
        }
      }
      return result;
    },
  };
  return { state, store };
}

function runtime() {
  let clockCalls = 0;
  let idCalls = 0;
  return {
    now: () => { clockCalls += 1; return now; },
    createLogId: () => { idCalls += 1; return `server-log-${idCalls}`; },
    calls: () => ({ clockCalls, idCalls }),
  };
}

async function rejectsWithoutWrites(reason, setup, request = { requestId }) {
  const { state, store } = fixture(setup);
  await assert.rejects(swapTeamRolesForAdmin(adminUid, request, store, runtime()), error => {
    assert.ok(error instanceof AdminGameStateServiceError);
    assert.equal(error.reason, reason);
    return true;
  });
  assert.deepEqual(state.writes, []);
}

describe('Admin Game State service', () => {
  test('atomically swaps Config, ordinary roster, and one capped server log', async () => {
    const oldLogs = Array.from({ length: 205 }, (_, index) => ({ id: `old-${index}` }));
    const { state, store } = fixture({
      users: [
        player('a-active', 'A', 'ACTIVE', { invincibleCards: 2, score: 11 }),
        player('a-waiting', 'A', 'WAITING', { waitingUntil: now + 10, shinkansenStartTime: now - 20 }),
        player('b-active', 'B', 'ACTIVE'),
        player('emergency', 'A', 'EMERGENCY'),
        player('retired', 'B', 'RETIRED'),
        player('captured', 'A', 'CAPTURED'),
        player('admin-user', 'ADMIN', 'ACTIVE'),
      ],
      gameConfig: config({ logs: oldLogs, teamAScore: 91, teamBScore: 82 }),
    });
    const before = structuredClone([...state.users]);
    const clock = runtime();
    const result = await swapTeamRolesForAdmin(adminUid, { requestId }, store, clock);

    assert.deepEqual(result, {
      ok: true, replayed: false, teamARole: 'RUNNER', teamBRole: 'ONI',
      nextRevealTime: now + 30 * 60 * 1000, newOniTeam: 'B',
    });
    assert.deepEqual(clock.calls(), { clockCalls: 1, idCalls: 1 });
    assert.equal(state.config.teamARole, 'RUNNER');
    assert.equal(state.config.teamBRole, 'ONI');
    assert.equal(state.config.nextRevealTime, now + 30 * 60 * 1000);
    assert.equal(state.config.teamAScore, 91);
    assert.equal(state.config.teamBScore, 82);
    assert.equal(state.config.logs.length, 200);
    assert.deepEqual(state.config.logs[0], {
      id: 'server-log-1', timestamp: now,
      message: '【運営操作】攻守を強制的に交代しました (新・鬼: Team B)', type: 'SYSTEM',
    });
    assert.deepEqual(state.users.get('a-active'), {
      ...before.find(([id]) => id === 'a-active')[1],
      status: 'ACTIVE', waitingUntil: 0, shinkansenStartTime: null,
    });
    assert.deepEqual(state.users.get('a-waiting'), {
      ...before.find(([id]) => id === 'a-waiting')[1],
      status: 'ACTIVE', waitingUntil: 0, shinkansenStartTime: null,
    });
    for (const id of ['b-active']) {
      assert.equal(state.users.get(id).status, 'WAITING');
      assert.equal(state.users.get(id).waitingUntil, now + 30 * 60 * 1000);
      assert.equal(state.users.get(id).shinkansenStartTime, null);
      assert.equal(state.users.get(id).invincibleUntil, 0);
    }
    for (const id of ['emergency', 'retired', 'captured', 'admin-user']) {
      assert.deepEqual(state.users.get(id), before.find(([beforeId]) => beforeId === id)[1]);
    }
    assert.equal(state.users.get('a-active').invincibleCards, 2);
    assert.equal(state.users.get('a-active').score, 11);
    assert.equal(state.writes.length, 1);
  });

  test('same request ID is idempotent across retries and does not duplicate writes/logs', async () => {
    const { state, store } = fixture({ users: [player('a', 'A'), player('b', 'B')] });
    const first = await swapTeamRolesForAdmin(adminUid, { requestId }, store, runtime());
    const second = await swapTeamRolesForAdmin(adminUid, { requestId }, store, runtime());
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.teamARole, first.teamARole);
    assert.equal(state.writes.length, 1);
    assert.equal(state.config.logs.length, 1);
  });

  test('rejects missing authorization/config, malformed roles/roster, excess writes and requests without writes', async () => {
    await rejectsWithoutWrites('PERMISSION_DENIED', { admin: false });
    await rejectsWithoutWrites('CONFIG_NOT_FOUND', { gameConfig: null });
    await rejectsWithoutWrites('INVALID_GAME_CONFIG', { gameConfig: config({ teamARole: 'bad' }) });
    await rejectsWithoutWrites('INVALID_GAME_CONFIG', { gameConfig: config({ teamBRole: 'ONI' }) });
    await rejectsWithoutWrites('INVALID_GAME_CONFIG', { gameConfig: config({ logs: 'bad' }) });
    await rejectsWithoutWrites('INVALID_ROSTER', { users: [player('a', 'A', 'UNKNOWN')] });
    await rejectsWithoutWrites('INVALID_ROSTER', { users: [player('a', 'A', 'ACTIVE', { name: '' })] });
    await rejectsWithoutWrites('ROSTER_TOO_LARGE', {
      users: Array.from({ length: 499 }, (_, index) => player(`player-${index}`, index % 2 ? 'B' : 'A')),
    });
    for (const request of [null, [], 'x', {}, { requestId: '' }, { requestId, team: 'A' }, { requestId: 'not-a-uuid' }]) {
      const { state, store } = fixture();
      await assert.rejects(swapTeamRolesForAdmin(adminUid, request, store, runtime()), AdminGameStateServiceError);
      assert.deepEqual(state.writes, []);
    }
    await assert.rejects(swapTeamRolesForAdmin('', { requestId }, fixture().store, runtime()), error => error.reason === 'UNAUTHENTICATED');
  });

  test('Resume transitions WAITING, Safety, Retired and legacy CAPTURED; preserves unrelated fields', async () => {
    for (const status of ['WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED']) {
      const original = player('target', 'B', status, {
        waitingUntil: now + 60_000, shinkansenStartTime: now - 1,
        invincibleUntil: now + 50_000, invincibleCards: 5, score: 33,
      });
      const { state, store } = fixture({ users: [original, player('other', 'A')] });
      const result = await resumePlayerForAdmin(adminUid, { targetId: 'target' }, store, runtime());
      const resumed = state.users.get('target');
      assert.deepEqual(result, { ok: true, resumed: true, status: 'ACTIVE' });
      assert.equal(resumed.status, 'ACTIVE');
      assert.equal(resumed.waitingUntil, 0);
      assert.equal(resumed.shinkansenStartTime, null);
      assert.equal(resumed.invincibleUntil, ['EMERGENCY', 'RETIRED'].includes(status) ? 0 : original.invincibleUntil);
      assert.equal(resumed.invincibleCards, original.invincibleCards);
      assert.equal(resumed.score, original.score);
      assert.equal(resumed.team, original.team);
      assert.deepEqual(state.users.get('other'), player('other', 'A'));
      assert.equal(state.config.logs.length, 1);
      assert.match(state.config.logs[0].message, new RegExp(`Player target を ${status} から ACTIVE`));
      assert.equal(state.writes.length, 2);
    }
  });

  test('ACTIVE Resume is a no-op with no writes or duplicate audit log', async () => {
    const { state, store } = fixture({ users: [player('target', 'A', 'ACTIVE')] });
    const before = structuredClone(state.users.get('target'));
    assert.deepEqual(await resumePlayerForAdmin(adminUid, { targetId: 'target' }, store, runtime()), {
      ok: true, resumed: false, status: 'ACTIVE',
    });
    assert.deepEqual(state.users.get('target'), before);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.config.logs, []);
  });

  test('Resume rejects missing, malformed, unknown-team/status, unauthenticated, and extra input without writes', async () => {
    for (const [request, options, reason] of [
      [{ targetId: 'missing' }, { users: [] }, 'PLAYER_NOT_FOUND'],
      [{ targetId: 'target' }, { users: [player('target', 'ADMIN')] }, 'INVALID_TEAM'],
      [{ targetId: 'target' }, { users: [player('target', 'A', 'UNKNOWN')] }, 'INVALID_PLAYER_STATE'],
      [{ targetId: 'target', extra: true }, { users: [player('target')] }, 'INVALID_ARGUMENT'],
      [{ targetId: '../x' }, { users: [] }, 'INVALID_ARGUMENT'],
    ]) {
      const { state, store } = fixture(options);
      await assert.rejects(resumePlayerForAdmin(adminUid, request, store, runtime()), error => error.reason === reason);
      assert.deepEqual(state.writes, []);
    }
    const { state, store } = fixture({ users: [player('target')], admin: false });
    await assert.rejects(resumePlayerForAdmin(adminUid, { targetId: 'target' }, store, runtime()), error => error.reason === 'PERMISSION_DENIED');
    assert.deepEqual(state.writes, []);
  });

  test('storage failure is mapped to PERSISTENCE_ERROR with no partial service writes', async () => {
    const store = { runTransaction: async () => { throw new Error('transaction unavailable'); } };
    await assert.rejects(swapTeamRolesForAdmin(adminUid, { requestId }, store, runtime()), error => error.reason === 'PERSISTENCE_ERROR');
    await assert.rejects(resumePlayerForAdmin(adminUid, { targetId: 'target' }, store, runtime()), error => error.reason === 'PERSISTENCE_ERROR');

    const { state, store: baseStore } = fixture({ users: [player('a', 'A'), player('b', 'B')] });
    const commitFailureStore = {
      runTransaction: work => baseStore.runTransaction(async transaction => {
        await work(transaction);
        throw new Error('commit aborted');
      }),
    };
    await assert.rejects(
      swapTeamRolesForAdmin(adminUid, { requestId }, commitFailureStore, runtime()),
      error => error.reason === 'PERSISTENCE_ERROR',
    );
    assert.deepEqual(state.writes, []);
    assert.equal(state.config.teamARole, 'ONI');
    assert.equal(state.users.get('a').status, 'ACTIVE');
  });
});
