import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AdminRevealServiceError,
  revealPlayerLocationsForAdmin,
} from '../lib/functions/src/admin/adminRevealService.js';

const now = 1_800_000_000_000;
const adminUid = 'trusted-admin';
const requestId = '123e4567-e89b-42d3-a456-426614174000';

function timestamp(millis) {
  return { toMillis: () => millis };
}

function player(id, team = 'A', status = 'ACTIVE') {
  return { id, data: { id, team, status } };
}

function location(id, overrides = {}) {
  return {
    id,
    data: { latitude: 35.1, longitude: 139.1, updatedAt: timestamp(now - 1_000), ...overrides },
  };
}

function fixture({ roster = [player('a', 'A'), player('b', 'B')], locations = [location('a'), location('b')], config = { logs: [] }, admin = true, receipt = null, snapshots = [], fail = false } = {}) {
  const state = {
    roster: structuredClone(roster),
    locations: locations.map(document => ({ id: document.id, data: { ...document.data } })),
    config: config === null ? null : structuredClone(config),
    admin,
    receipt,
    snapshots: new Map(snapshots),
    writes: [],
    reads: [],
  };
  const store = {
    async runTransaction(work) {
      if (fail) throw new Error('transaction failure');
      const pending = [];
      const result = await work({
        readAdmin: async uid => { state.reads.push(['admin', uid]); return state.admin && uid === adminUid; },
        readReceipt: async (uid, key) => {
          state.reads.push(['receipt', uid, key]);
          return state.receipt?.requestId === key ? state.receipt : null;
        },
        readGameConfig: async () => { state.reads.push(['config']); return state.config && structuredClone(state.config); },
        readParticipantRoster: async () => { state.reads.push(['roster']); return structuredClone(state.roster); },
        readPrivateLocations: async ids => {
          state.reads.push(['privateLocations', [...ids]]);
          return state.locations.filter(document => ids.includes(document.id))
            .map(document => ({ id: document.id, data: { ...document.data } }));
        },
        readExistingSnapshots: async ids => {
          state.reads.push(['exposedLocations', [...ids]]);
          return ids.flatMap(id => state.snapshots.has(id) ? [{ id, data: structuredClone(state.snapshots.get(id)) }] : []);
        },
        writeReveal: (uid, configField, expiresAt, snapshots, logs, receiptValue) => pending.push({
          uid, configField, expiresAt, snapshots: structuredClone(snapshots),
          logs: structuredClone(logs), receipt: structuredClone(receiptValue),
        }),
      });
      for (const write of pending) {
        state.writes.push(write);
        state.config[write.configField] = write.expiresAt;
        state.config.logs = write.logs;
        for (const snapshot of write.snapshots) state.snapshots.set(snapshot.playerId, snapshot);
        state.receipt = {
          ...write.receipt,
          expiresAt: timestamp(write.receipt.expiresAt),
        };
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
    createLogId: () => { idCalls += 1; return `trusted-log-${idCalls}`; },
    calls: () => ({ clockCalls, idCalls }),
  };
}

function request(overrides = {}) {
  return { scope: 'GLOBAL', durationMinutes: 5, requestId, ...overrides };
}

async function rejectWithoutWrites(reason, options, intent = request()) {
  const { state, store } = fixture(options);
  await assert.rejects(revealPlayerLocationsForAdmin(adminUid, intent, store, runtime()), error => {
    assert.ok(error instanceof AdminRevealServiceError);
    assert.equal(error.reason, reason);
    return true;
  });
  assert.deepEqual(state.writes, []);
  assert.equal(state.snapshots.size, 0);
}

describe('Admin Reveal service', () => {
  test('atomically writes fresh GLOBAL snapshots, Config deadline, receipt, and capped server log', async () => {
    const oldLogs = Array.from({ length: 205 }, (_, index) => ({ id: `old-${index}` }));
    const { state, store } = fixture({
      roster: [player('a', 'A'), player('b', 'B'), player('emergency', 'A', 'EMERGENCY'), player('retired', 'B', 'RETIRED')],
      locations: [location('a'), location('b'), location('emergency'), location('retired')],
      config: { logs: oldLogs, locationRevealUntil: 123, teamAScore: 11 },
    });
    const clock = runtime();
    const before = {
      roster: structuredClone(state.roster),
      locations: state.locations.map(document => ({
        id: document.id,
        data: { ...document.data, updatedAt: document.data.updatedAt.toMillis() },
      })),
      config: structuredClone(state.config),
    }
    const result = await revealPlayerLocationsForAdmin(adminUid, request(), store, clock);

    assert.deepEqual(result, {
      ok: true, scope: 'GLOBAL', expiresAt: now + 300_000,
      projectedCount: 2, skippedCount: 2, duplicate: false,
    });
    assert.deepEqual(clock.calls(), { clockCalls: 1, idCalls: 1 });
    assert.equal(state.snapshots.size, 2);
    assert.deepEqual(state.snapshots.get('a'), {
      playerId: 'a', latitude: 35.1, longitude: 139.1,
      capturedAt: now, expiresAt: now + 300_000, revealScope: 'GLOBAL',
    });
    assert.equal(state.config.locationRevealUntil, now + 300_000);
    assert.equal(state.config.teamAScore, 11);
    assert.equal(state.config.teamARevealUntil, undefined);
    assert.equal(state.config.logs.length, 200);
    assert.equal(state.config.logs[0].id, 'trusted-log-1');
    assert.match(state.config.logs[0].message, /運営操作:trusted-admin.*GLOBAL.*公開2名、除外2名/);
    assert.equal(state.receipt.projectedCount, 2);
    assert.equal(state.receipt.skippedCount, 2);
    assert.deepEqual(state.roster, before.roster);
    assert.deepEqual(state.locations.map(document => ({
      id: document.id,
      data: { ...document.data, updatedAt: document.data.updatedAt.toMillis() },
    })), before.locations);
    assert.equal(state.config.teamAScore, before.config.teamAScore);
    assert.deepEqual(before.config.logs, oldLogs);
    assert.equal('latitude' in result, false);
  });

  test('supports TEAM_A and TEAM_B, writing only the corresponding deadline and target snapshots', async () => {
    for (const [scope, target, field] of [
      ['TEAM_A', 'a', 'teamARevealUntil'], ['TEAM_B', 'b', 'teamBRevealUntil'],
    ]) {
      const { state, store } = fixture();
      const result = await revealPlayerLocationsForAdmin(adminUid, request({ scope }), store, runtime());
      assert.equal(result.scope, scope);
      assert.deepEqual([...state.snapshots.keys()], [target]);
      assert.equal(state.config[field], now + 300_000);
      assert.equal(state.config.locationRevealUntil, undefined);
      assert.equal(state.config[scope === 'TEAM_A' ? 'teamBRevealUntil' : 'teamARevealUntil'], undefined);
    }
  });

  test('replaces an existing Owner individual snapshot with the trusted scoped snapshot', async () => {
    const priorSnapshot = {
      latitude: 34, longitude: 138, capturedAt: now - 10_000, expiresAt: now + 100_000,
    };
    const { state, store } = fixture({ snapshots: [['a', priorSnapshot]] });
    await revealPlayerLocationsForAdmin(adminUid, request({ scope: 'TEAM_A' }), store, runtime());
    assert.deepEqual(state.snapshots.get('a'), {
      playerId: 'a', latitude: 35.1, longitude: 139.1,
      capturedAt: now, expiresAt: now + 300_000, revealScope: 'TEAM_A',
    });
  });

  test('reads private locations only for in-scope ordinary participants', async () => {
    const cases = [
      {
        scope: 'TEAM_A',
        roster: [player('a', 'A'), player('b', 'B')],
        expected: ['a'],
      },
      {
        scope: 'TEAM_B',
        roster: [player('a', 'A'), player('b', 'B')],
        expected: ['b'],
      },
      {
        scope: 'GLOBAL',
        roster: [
          player('a', 'A'), player('b', 'B'), player('emergency', 'A', 'EMERGENCY'),
          player('retired', 'B', 'RETIRED'), player('admin', 'ADMIN'), player('unknown', 'X'),
        ],
        expected: ['a', 'b'],
      },
    ];

    for (const { scope, roster, expected } of cases) {
      const locations = roster.map(value => location(value.id));
      const { state, store } = fixture({ roster, locations });
      await revealPlayerLocationsForAdmin(adminUid, request({ scope }), store, runtime());
      assert.deepEqual(state.reads.find(([kind]) => kind === 'privateLocations')[1], expected);
      assert.deepEqual(state.reads.find(([kind]) => kind === 'exposedLocations')[1], expected);
    }
  });

  test('skips stale, missing, and malformed locations while projecting fresh players', async () => {
    const { state, store } = fixture({
      roster: [player('fresh'), player('missing'), player('stale'), player('bad')],
      locations: [
        location('fresh'),
        location('stale', { updatedAt: timestamp(now - 120_000) }),
        location('bad', { longitude: 181 }),
      ],
    });
    const result = await revealPlayerLocationsForAdmin(adminUid, request(), store, runtime());
    assert.equal(result.projectedCount, 1);
    assert.equal(result.skippedCount, 3);
    assert.deepEqual([...state.snapshots.keys()], ['fresh']);
  });

  test('rejects unauthenticated, non-admin, malformed request, config, roster, empty snapshots, and write overflow without writes', async () => {
    await assert.rejects(revealPlayerLocationsForAdmin('', request(), fixture().store, runtime()), error => error.reason === 'UNAUTHENTICATED');
    await rejectWithoutWrites('PERMISSION_DENIED', { admin: false });
    for (const invalid of [
      request({ scope: 'ALL' }), request({ durationMinutes: 31 }), request({ durationMinutes: 1.5 }),
      request({ requestId: 'not-a-uuid' }), { ...request(), adminId: adminUid },
    ]) {
      await rejectWithoutWrites('INVALID_ARGUMENT', {}, invalid);
    }
    await rejectWithoutWrites('CONFIG_NOT_FOUND', { config: null });
    await rejectWithoutWrites('INVALID_GAME_CONFIG', { config: { logs: 'bad' } });
    await rejectWithoutWrites('INVALID_ROSTER', { roster: [player('broken', 'A', 'UNKNOWN')] });
    await rejectWithoutWrites('ZERO_VALID_LOCATIONS', { locations: [] });
    const oversizedRoster = Array.from({ length: 499 }, (_, index) => player(`player-${index}`));
    const oversizedLocations = oversizedRoster.map(value => location(value.id));
    await rejectWithoutWrites('WRITE_LIMIT_EXCEEDED', { roster: oversizedRoster, locations: oversizedLocations });
  });

  test('same request ID returns stable prior result without extending deadline, rewriting snapshots, or logging', async () => {
    const initialReceipt = {
      action: 'revealPlayerLocations', requestId, scope: 'TEAM_A',
      expiresAt: timestamp(now + 100_000), projectedCount: 1, skippedCount: 2,
    };
    const { state, store } = fixture({ receipt: initialReceipt });
    const result = await revealPlayerLocationsForAdmin(adminUid, request({ scope: 'TEAM_A' }), store, runtime());
    assert.deepEqual(result, {
      ok: true, scope: 'TEAM_A', expiresAt: now + 100_000,
      projectedCount: 1, skippedCount: 2, duplicate: true,
    });
    assert.deepEqual(state.writes, []);
    assert.equal(state.config.logs.length, 0);
    assert.equal(state.config.teamARevealUntil, undefined);
  });

  test('transaction failures become a stable persistence error', async () => {
    const { store } = fixture({ fail: true });
    await assert.rejects(revealPlayerLocationsForAdmin(adminUid, request(), store, runtime()), error => {
      assert.ok(error instanceof AdminRevealServiceError);
      assert.equal(error.reason, 'PERSISTENCE_ERROR');
      return true;
    });
  });
});
