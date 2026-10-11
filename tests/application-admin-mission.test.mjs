import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assignMissions, setMissionMode, syncMissionCatalog } from '../src/application/adminMissionActions.ts';

describe('admin mission application actions', () => {
  test('forwards minimal mode, manual, random and catalog intents and trusted results', async () => {
    const received = [];
    const gateway = {
      setMissionMode: async input => { received.push(input); return { ok: true, action: 'setMissionMode', mode: input.mode, changed: true, duplicate: false }; },
      assignMissions: async input => { received.push(input); return { ok: true, action: 'assignMissions', strategy: input.strategy, target: input.target, selectedMissionIds: ['m01'], duplicate: false }; },
      syncMissionCatalog: async input => { received.push(input); return { ok: true, action: 'syncMissionCatalog', createdCount: 1, updatedCount: 2, unchangedCount: 33, totalManagedCount: 36, duplicate: false }; },
    };
    const mode = { mode: 'SAME', requestId: 'mode-id' };
    const manual = { strategy: 'MANUAL', target: 'TEAM_A', missionId: 'm01', requestId: 'manual-id' };
    const random = { strategy: 'RANDOM', target: 'BOTH', requestId: 'random-id' };
    const sync = { requestId: 'sync-id' };
    assert.equal((await setMissionMode(mode, gateway)).changed, true);
    assert.equal((await assignMissions(manual, gateway)).strategy, 'MANUAL');
    assert.equal((await assignMissions(random, gateway)).strategy, 'RANDOM');
    assert.equal((await syncMissionCatalog(sync, gateway)).totalManagedCount, 36);
    assert.deepEqual(received, [mode, manual, random, sync]);
    assert.deepEqual(Object.keys(received[1]).sort(), ['missionId', 'requestId', 'strategy', 'target']);
    assert.deepEqual(Object.keys(received[2]).sort(), ['requestId', 'strategy', 'target']);
  });

  test('forwards duplicate result, domain rejection, and maps transport failures', async () => {
    const replay = { ok: true, action: 'setMissionMode', mode: 'SAME', changed: true, duplicate: true };
    assert.deepEqual(await setMissionMode({ mode: 'SAME', requestId: 'id' }, { setMissionMode: async () => replay }), replay);
    assert.deepEqual(await assignMissions({ strategy: 'MANUAL', target: 'TEAM_B', missionId: 'm02', requestId: 'id' }, { assignMissions: async () => ({ ok: false, reason: 'INVALID_MISSION' }) }), { ok: false, reason: 'INVALID_MISSION' });
    assert.deepEqual(await syncMissionCatalog({ requestId: 'id' }, { syncMissionCatalog: async () => { throw Error('transport'); } }), { ok: false, reason: 'PERSISTENCE_ERROR' });
  });
});
