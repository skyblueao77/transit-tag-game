import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MISSIONS, FINAL_MISSIONS } from '../../constants.ts';
import {
  planMissionCatalogSync,
  resolveMissionAssignment,
  resolveMissionModeChange,
  validateCanonicalMission,
} from '../../src/game/adminMission.ts';

const catalog = [...MISSIONS, ...FINAL_MISSIONS];
const missionData = mission => Object.fromEntries(Object.entries(mission));

describe('trusted mission administration core', () => {
  test('canonical catalog contains 32 Normal and 4 Final missions with unique IDs and valid schemas', () => {
    assert.equal(MISSIONS.length, 32);
    assert.equal(FINAL_MISSIONS.length, 4);
    assert.equal(catalog.length, 36);
    assert.equal(new Set(catalog.map(mission => mission.id)).size, 36);
    for (const mission of catalog) assert.equal(validateCanonicalMission(missionData(mission), mission), true);
  });

  test('mode changes accept SAME/DIFFERENT and same value is a no-op', () => {
    assert.deepEqual(resolveMissionModeChange('DIFFERENT', 'SAME'), { allowed: true, mode: 'SAME', changed: true });
    assert.deepEqual(resolveMissionModeChange('SAME', 'SAME'), { allowed: true, mode: 'SAME', changed: false });
    assert.deepEqual(resolveMissionModeChange('unknown', 'SAME'), { allowed: false, reason: 'INVALID_MODE' });
    assert.deepEqual(resolveMissionModeChange('SAME', 'unknown'), { allowed: false, reason: 'INVALID_MODE' });
  });

  test('manual assignment updates only its target and requires exact canonical Normal document', () => {
    const persisted = { [MISSIONS[0].id]: missionData(MISSIONS[0]) };
    const input = { phase: 'PRE_GAME', currentMode: 'SAME', catalog: MISSIONS, persistedMissions: persisted, strategy: 'MANUAL', target: 'TEAM_A', missionId: MISSIONS[0].id };
    const before = structuredClone(input);
    assert.deepEqual(resolveMissionAssignment(input), {
      allowed: true, strategy: 'MANUAL', target: 'TEAM_A', activeMissionA: MISSIONS[0].id, selectedMissionIds: [MISSIONS[0].id],
    });
    assert.deepEqual(input, before);
    assert.equal(resolveMissionAssignment({ ...input, target: 'TEAM_B' }).activeMissionA, undefined);
    assert.equal(resolveMissionAssignment({ ...input, target: 'TEAM_B' }).activeMissionB, MISSIONS[0].id);
    assert.deepEqual(resolveMissionAssignment({ ...input, missionId: 'final_01' }), { allowed: false, reason: 'INVALID_MISSION' });
    assert.deepEqual(resolveMissionAssignment({ ...input, missionId: 'unknown' }), { allowed: false, reason: 'INVALID_MISSION' });
    assert.deepEqual(resolveMissionAssignment({ ...input, persistedMissions: { [MISSIONS[0].id]: { ...missionData(MISSIONS[0]), points: '15' } } }), { allowed: false, reason: 'INVALID_MISSION' });
    assert.deepEqual(resolveMissionAssignment({ ...input, persistedMissions: { [MISSIONS[0].id]: { ...missionData(MISSIONS[0]), extra: true } } }), { allowed: false, reason: 'INVALID_MISSION' });
  });

  test('random SAME uses one canonical ID for both teams and deterministic injected random', () => {
    const result = resolveMissionAssignment({ phase: 'DAY1_ACTIVE', currentMode: 'SAME', catalog: MISSIONS, strategy: 'RANDOM', target: 'BOTH', randomValues: [0.5, 0.9] });
    assert.equal(result.allowed, true);
    assert.equal(result.activeMissionA, result.activeMissionB);
    assert.equal(result.activeMissionA, MISSIONS[Math.floor(0.5 * MISSIONS.length)].id);
  });

  test('random DIFFERENT always selects distinct Normal IDs, even if draws collide', () => {
    const result = resolveMissionAssignment({ phase: 'DAY2_PAUSED', currentMode: 'DIFFERENT', catalog: MISSIONS, strategy: 'RANDOM', target: 'BOTH', randomValues: [0.25, 0.25] });
    assert.equal(result.allowed, true);
    assert.notEqual(result.activeMissionA, result.activeMissionB);
    assert.deepEqual(result.selectedMissionIds.length, 2);
  });

  test('assignment phase and request combination validation is fail-closed', () => {
    for (const phase of ['PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_ACTIVE', 'DAY2_PAUSED']) {
      const result = resolveMissionAssignment({ phase, currentMode: 'SAME', catalog: MISSIONS, strategy: 'RANDOM', target: 'BOTH', randomValues: [0.1, 0.2] });
      assert.equal(result.allowed, true, phase);
    }
    assert.deepEqual(resolveMissionAssignment({ phase: 'FINAL_MISSION', currentMode: 'SAME', catalog: MISSIONS, strategy: 'RANDOM', target: 'BOTH', randomValues: [0, 0.5] }), { allowed: false, reason: 'ASSIGNMENT_NOT_ALLOWED' });
    assert.deepEqual(resolveMissionAssignment({ phase: 'GAME_OVER', currentMode: 'SAME', catalog: MISSIONS, strategy: 'RANDOM', target: 'BOTH', randomValues: [0, 0.5] }), { allowed: false, reason: 'ASSIGNMENT_NOT_ALLOWED' });
    assert.deepEqual(resolveMissionAssignment({ phase: 'broken', currentMode: 'SAME', catalog: MISSIONS, strategy: 'RANDOM', target: 'BOTH', randomValues: [0, 0.5] }), { allowed: false, reason: 'INVALID_PHASE' });
    assert.deepEqual(resolveMissionAssignment({ phase: 'PRE_GAME', currentMode: 'SAME', catalog: MISSIONS, strategy: 'RANDOM', target: 'TEAM_A', randomValues: [0, 0.5] }), { allowed: false, reason: 'INVALID_TARGET' });
    assert.deepEqual(resolveMissionAssignment({ phase: 'PRE_GAME', currentMode: 'SAME', catalog: MISSIONS, strategy: 'MANUAL', target: 'BOTH', missionId: MISSIONS[0].id }), { allowed: false, reason: 'INVALID_TARGET' });
  });

  test('catalog sync creates, updates and leaves canonical documents unchanged without touching unknown IDs', () => {
    const persisted = {
      [MISSIONS[0].id]: missionData(MISSIONS[0]),
      [MISSIONS[1].id]: { ...missionData(MISSIONS[1]), points: 'wrong' },
      custom_mission: { id: 'custom_mission', title: 'keep' },
    };
    const before = structuredClone(persisted);
    const plan = planMissionCatalogSync(catalog, persisted);
    assert.equal(plan.allowed, true);
    assert.equal(plan.totalManagedCount, 36);
    assert.equal(plan.createdCount, 34);
    assert.equal(plan.updatedCount, 1);
    assert.equal(plan.unchangedCount, 1);
    assert.equal(plan.upserts.length, 35);
    assert.equal(plan.upserts.some(mission => mission.id === 'custom_mission'), false);
    assert.deepEqual(persisted, before);
    assert.equal(planMissionCatalogSync(catalog, Object.fromEntries(catalog.map(mission => [mission.id, missionData(mission)]) )).upserts.length, 0);
  });
});
