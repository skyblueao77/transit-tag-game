import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveAdminPhaseTransition } from '../../src/game/adminPhaseTransition.ts';
import { FINAL_MISSION_DURATION_MS } from '../../src/game/time.ts';

const now = 1_800_000_000_000;
const pairs = [['PRE_GAME','START_DAY1','DAY1_ACTIVE'],['DAY1_ACTIVE','PAUSE','DAY1_PAUSED'],['DAY1_PAUSED','RESUME','DAY1_ACTIVE'],['DAY1_ACTIVE','END_DAY1','DAY1_ENDED'],['DAY1_ENDED','START_DAY2','DAY2_ACTIVE'],['DAY2_ACTIVE','PAUSE','DAY2_PAUSED'],['DAY2_PAUSED','RESUME','DAY2_ACTIVE'],['DAY2_ACTIVE','START_FINAL','FINAL_MISSION'],['FINAL_MISSION','END_GAME','GAME_OVER']];
describe('trusted admin phase core', () => {
  for (const [phase, action, next] of pairs) test(`${phase} + ${action}`, () => {
    const input = { currentPhase: phase, action, now, finalMissionId: action === 'START_FINAL' ? 'final_01' : undefined };
    const before = structuredClone(input);
    const result = resolveAdminPhaseTransition(input);
    assert.equal(result.allowed, true); assert.equal(result.newPhase, next); assert.deepEqual(input, before);
  });
  test('rejects reverse, skip, same, terminal, malformed and wrong final action', () => {
    for (const [currentPhase, action] of [['DAY1_ACTIVE','START_DAY1'],['DAY1_PAUSED','END_DAY1'],['PRE_GAME','START_DAY2'],['GAME_OVER','START_DAY1'],['wat','PAUSE'],['DAY1_ACTIVE','RESUME'],['DAY1_ENDED','START_FINAL']]) assert.equal(resolveAdminPhaseTransition({ currentPhase, action, now }).allowed, false);
  });
  test('sets server side effects and preserves unrelated config by returning field patch only', () => {
    assert.deepEqual(resolveAdminPhaseTransition({ currentPhase:'PRE_GAME', action:'START_DAY1', now }).updates, { gameStatus:'DAY1_ACTIVE', day:1, startTime:now, isGameOver:false, isFinalMissionActive:false, activeFinalMissionId:null, finalMissionEndTime:0 });
    const day2 = resolveAdminPhaseTransition({ currentPhase:'DAY1_ENDED', action:'START_DAY2', now }); assert.deepEqual(day2.updates, { gameStatus:'DAY2_ACTIVE', day:2 });
    const paused = resolveAdminPhaseTransition({ currentPhase:'DAY2_ACTIVE', action:'PAUSE', now }); assert.deepEqual(paused.updates, { gameStatus:'DAY2_PAUSED' });
    const final = resolveAdminPhaseTransition({ currentPhase:'DAY2_ACTIVE', action:'START_FINAL', now, finalMissionId:'final_01' }); assert.equal(final.updates.finalMissionEndTime, now + FINAL_MISSION_DURATION_MS); assert.equal(final.updates.isFinalMissionActive, true);
    const ended = resolveAdminPhaseTransition({ currentPhase:'FINAL_MISSION', action:'END_GAME', now }); assert.equal(ended.updates.isGameOver, true); assert.equal(ended.updates.isFinalMissionActive, false);
  });
});
