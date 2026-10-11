import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ADMIN_MISSION_CATALOG, AdminMissionServiceError, administerMissionForAdmin } from '../lib/functions/src/admin/adminMissionService.js';

const uid = 'trusted-admin';
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const now = 1_800_000_000_000;
const modeRequest = (mode, id = requestId, extra = {}) => ({ action: 'setMissionMode', mode, requestId: id, ...extra });
function missionMap(entries = []) { return Object.fromEntries(entries.map(mission => [mission.id, structuredClone(mission)])); }
function config(extra = {}) { return { gameStatus: 'PRE_GAME', missionMode: 'DIFFERENT', activeMissionA: 'm-old-a', activeMissionB: 'm-old-b', activeFinalMissionId: 'final_01', teamAScore: 13, teamBScore: 17, logs: [], untouched: 'preserve', ...extra }; }
function fixture({ admin = true, gameConfig = config(), missions = {}, failWrite = false } = {}) {
  const state = { admin, config: gameConfig && structuredClone(gameConfig), missions: structuredClone(missions), receipts: new Map(), writes: [], reads: [], failWrite };
  const store = {
    runTransaction: async work => {
      const pending = [];
      const tx = {
        readAdmin: async actor => { state.reads.push(`admin:${actor}`); return actor === uid && state.admin; },
        readReceipt: async (actor, action, id) => { state.reads.push(`receipt:${action}`); return structuredClone(state.receipts.get(`${actor}:${action}:${id}`) ?? null); },
        readConfig: async () => { state.reads.push('config'); return structuredClone(state.config); },
        readMissions: async ids => {
          state.reads.push(...ids.map(id => `mission:${id}`));
          return Object.fromEntries(ids.map(id => [id, structuredClone(state.missions[id] ?? null)]));
        },
        updateConfig: patch => { state.writes.push('config'); pending.push(() => { state.config = { ...state.config, ...structuredClone(patch) }; }); },
        upsertMission: (id, mission) => { state.writes.push(`mission:${id}`); pending.push(() => { state.missions[id] = structuredClone(mission); }); },
        createReceipt: (actor, action, id, receipt) => { state.writes.push(`receipt:${action}`); pending.push(() => { state.receipts.set(`${actor}:${action}:${id}`, structuredClone(receipt)); }); },
      };
      const result = await work(tx);
      if (state.failWrite && pending.length) throw Error('storage failure');
      pending.forEach(apply => apply());
      return result;
    },
  };
  let calls = { now: 0, id: 0, random: 0 };
  const runtime = { now: () => { calls.now += 1; return now; }, createId: () => { calls.id += 1; return 'server-log-id'; }, random: () => { calls.random += 1; return calls.random === 1 ? 0.1 : 0.7; } };
  return { state, store, runtime, calls };
}
const manual = (target, missionId, id = requestId) => ({ action: 'assignMissions', strategy: 'MANUAL', target, missionId, requestId: id });
const random = (id = requestId) => ({ action: 'assignMissions', strategy: 'RANDOM', target: 'BOTH', requestId: id });
const sync = (id = requestId) => ({ action: 'syncMissionCatalog', requestId: id });
async function rejected(reason, callback) {
  await assert.rejects(callback, error => error instanceof AdminMissionServiceError && error.reason === reason);
}

describe('trusted mission administration service', () => {
  test('mode updates only missionMode with trusted atomic audit and receipt; same mode is receipt-only no-op', async () => {
    const f = fixture({ gameConfig: config({ logs: Array.from({ length: 201 }, (_, i) => ({ id: `old-${i}` })) }) });
    const result = await administerMissionForAdmin(uid, modeRequest('SAME'), f.store, f.runtime);
    assert.deepEqual(result, { ok: true, action: 'setMissionMode', mode: 'SAME', changed: true, duplicate: false });
    assert.equal(f.state.config.missionMode, 'SAME');
    assert.equal(f.state.config.activeMissionA, 'm-old-a');
    assert.equal(f.state.config.untouched, 'preserve');
    assert.equal(f.state.config.logs.length, 200);
    assert.deepEqual(f.state.config.logs[0], { id: 'server-log-id', timestamp: now, type: 'MISSION', actorUid: uid, action: 'setMissionMode', mode: 'SAME', message: 'Mission mode changed to SAME' });
    assert.equal(f.state.writes.filter(value => value === 'config').length, 1);
    assert.equal(f.state.receipts.size, 1);
    const noop = fixture({ gameConfig: config({ missionMode: 'SAME' }) });
    const noChange = await administerMissionForAdmin(uid, modeRequest('SAME'), noop.store, noop.runtime);
    assert.equal(noChange.changed, false);
    assert.equal(noop.state.writes.includes('config'), false);
    assert.deepEqual(noop.state.writes, ['receipt:setMissionMode']);
    assert.equal(noop.state.config.logs.length, 0);
  });

  test('strictly validates authorization, requests and config before writes', async () => {
    for (const [setup, request, reason] of [
      [{ admin: false }, modeRequest('SAME'), 'PERMISSION_DENIED'],
      [{}, modeRequest('SAME', requestId, { actorUid: 'spoof' }), 'INVALID_ARGUMENT'],
      [{}, modeRequest('UNKNOWN'), 'INVALID_ARGUMENT'],
      [{}, { action: 'syncMissionCatalog', requestId: 'bad' }, 'INVALID_ARGUMENT'],
      [{ gameConfig: null }, modeRequest('SAME'), 'CONFIG_NOT_FOUND'],
      [{ gameConfig: config({ gameStatus: 'corrupt' }) }, modeRequest('SAME'), 'INVALID_CONFIG'],
      [{ gameConfig: config({ logs: {} }) }, modeRequest('SAME'), 'INVALID_CONFIG'],
    ]) {
      const f = fixture(setup);
      await rejected(reason, () => administerMissionForAdmin(uid, request, f.store, f.runtime));
      assert.equal(f.state.writes.length, 0);
    }
    const unauth = fixture();
    await rejected('UNAUTHENTICATED', () => administerMissionForAdmin('', modeRequest('SAME'), unauth.store, unauth.runtime));
    assert.equal(unauth.state.writes.length, 0);
  });

  test('manual Team A/B assignment validates canonical persisted data and changes only requested active field', async () => {
    const mission = ADMIN_MISSION_CATALOG[0];
    const f = fixture({ missions: missionMap([mission]) });
    const result = await administerMissionForAdmin(uid, manual('TEAM_B', mission.id), f.store, f.runtime);
    assert.equal(result.activeMissionB, mission.id);
    assert.equal(result.activeMissionA, undefined);
    assert.equal(f.state.config.activeMissionA, 'm-old-a');
    assert.equal(f.state.config.activeMissionB, mission.id);
    assert.equal(f.state.config.teamAScore, 13);
    assert.equal(f.state.config.logs[0].actorUid, uid);
    assert.equal(f.state.writes.includes('receipt:assignMissions'), true);
    assert.deepEqual(f.state.reads.filter(x => x.startsWith('mission:')), [`mission:${mission.id}`]);
  });

  test('rejects missing, malformed, noncanonical and Final missions without writes', async () => {
    const normal = ADMIN_MISSION_CATALOG[0];
    for (const [missions, id] of [
      [{}, normal.id],
      [{ [normal.id]: { ...normal, points: '15' } }, normal.id],
      [{ [normal.id]: { ...normal, extra: true } }, normal.id],
      [{}, 'final_01'],
      [{}, 'not-known'],
    ]) {
      const f = fixture({ missions });
      await rejected('INVALID_MISSION', () => administerMissionForAdmin(uid, manual('TEAM_A', id), f.store, f.runtime));
      assert.equal(f.state.writes.length, 0);
    }
    for (const phase of ['FINAL_MISSION', 'GAME_OVER', 'malformed']) {
      const f = fixture({ gameConfig: config({ gameStatus: phase }), missions: missionMap([normal]) });
      await rejected(phase === 'malformed' ? 'INVALID_CONFIG' : 'ASSIGNMENT_NOT_ALLOWED', () => administerMissionForAdmin(uid, manual('TEAM_A', normal.id), f.store, f.runtime));
      assert.equal(f.state.writes.length, 0);
    }
  });

  test('random SAME/DIFFERENT selections are server-side, retry-stable, and request receipt is idempotent', async () => {
    const same = fixture({ gameConfig: config({ missionMode: 'SAME' }), missions: missionMap(ADMIN_MISSION_CATALOG.slice(0, 32)) });
    const retriedStore = { runTransaction: async work => {
      const originalConfig = structuredClone(same.state.config);
      const originalMissions = structuredClone(same.state.missions);
      const originalReceipts = new Map(same.state.receipts);
      await same.store.runTransaction(work);
      same.state.config = originalConfig;
      same.state.missions = originalMissions;
      same.state.receipts = originalReceipts;
      return same.store.runTransaction(work);
    } };
    const sameResult = await administerMissionForAdmin(uid, random(), retriedStore, same.runtime);
    assert.equal(sameResult.duplicate, false);
    assert.equal(sameResult.activeMissionA, sameResult.activeMissionB);
    assert.equal(same.calls.random, 2);
    assert.equal(same.calls.now, 1);
    assert.equal(same.calls.id, 1);
    assert.equal(same.state.config.teamAScore, 13);
    assert.equal(same.state.config.logs.length, 1);

    const different = fixture({ gameConfig: config({ missionMode: 'DIFFERENT' }), missions: missionMap(ADMIN_MISSION_CATALOG.slice(0, 32)) });
    const differentResult = await administerMissionForAdmin(uid, random(), different.store, different.runtime);
    assert.notEqual(differentResult.activeMissionA, differentResult.activeMissionB);
    const stored = different.state.receipts.get(`${uid}:assignMissions:${requestId}`);
    const duplicateStore = { runTransaction: work => work({ readAdmin: async () => true, readReceipt: async () => stored, readConfig: async () => { throw Error('no config read'); }, readMissions: async () => { throw Error('no mission read'); }, updateConfig: () => { throw Error('no write'); }, upsertMission: () => { throw Error('no write'); }, createReceipt: () => { throw Error('no write'); } }) };
    const duplicate = await administerMissionForAdmin(uid, random(), duplicateStore, different.runtime);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.activeMissionA, differentResult.activeMissionA);
    assert.deepEqual(duplicate.activeMissionB, differentResult.activeMissionB);
  });

  test('catalog sync upserts all 36 canonical documents and preserves custom docs and active references', async () => {
    const existing = { ...missionMap([ADMIN_MISSION_CATALOG[0]]), [ADMIN_MISSION_CATALOG[1].id]: { ...ADMIN_MISSION_CATALOG[1], points: 'wrong' }, custom_mission: { id: 'custom_mission', title: 'preserve' } };
    const f = fixture({ missions: existing, gameConfig: config({ logs: Array.from({ length: 205 }, (_, i) => ({ id: `l${i}` })) }) });
    const result = await administerMissionForAdmin(uid, sync(), f.store, f.runtime);
    assert.deepEqual(result, { ok: true, action: 'syncMissionCatalog', createdCount: 34, updatedCount: 1, unchangedCount: 1, totalManagedCount: 36, duplicate: false });
    for (const mission of ADMIN_MISSION_CATALOG) assert.deepEqual(f.state.missions[mission.id], mission);
    assert.deepEqual(f.state.missions.custom_mission, { id: 'custom_mission', title: 'preserve' });
    assert.equal(f.state.config.activeMissionA, 'm-old-a');
    assert.equal(f.state.config.activeMissionB, 'm-old-b');
    assert.equal(f.state.config.activeFinalMissionId, 'final_01');
    assert.equal(f.state.config.teamAScore, 13);
    assert.equal(f.state.config.logs.length, 200);
    assert.equal(f.state.config.logs[0].actorUid, uid);
    assert.equal(f.state.config.logs[0].createdCount, 34);
    assert.equal(f.state.writes.filter(value => value.startsWith('mission:')).length, 35);
    assert.equal(f.state.missions.final_01.id, 'final_01');
  });

  test('catalog sync is idempotent; canonical documents unchanged still receive a stable audited receipt', async () => {
    const f = fixture({ missions: missionMap(ADMIN_MISSION_CATALOG) });
    const result = await administerMissionForAdmin(uid, sync(), f.store, f.runtime);
    assert.equal(result.createdCount, 0);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.unchangedCount, 36);
    assert.equal(f.state.writes.filter(value => value.startsWith('mission:')).length, 0);
    assert.deepEqual(f.state.writes, ['config', 'receipt:syncMissionCatalog']);
    assert.equal(f.state.config.logs[0].totalManagedCount, 36);
  });

  test('storage failure is mapped and transaction writes do not partially apply', async () => {
    const mission = ADMIN_MISSION_CATALOG[0];
    const f = fixture({ missions: missionMap([mission]), failWrite: true });
    await rejected('PERSISTENCE_ERROR', () => administerMissionForAdmin(uid, manual('TEAM_A', mission.id), f.store, f.runtime));
    assert.equal(f.state.config.activeMissionA, 'm-old-a');
    assert.equal(f.state.receipts.size, 0);
  });
});
