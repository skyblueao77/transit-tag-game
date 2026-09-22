import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  calculateMissionReward,
  canCompleteMission,
  isSameMissionId,
} from '../../src/game/missions.ts';
import { calculateMissionScore } from '../../src/game/scoring.ts';

const mission = (id, points) => ({ id, points });

describe('mission rewards and completion', () => {
  test('returns the mission points as the reward', () => {
    assert.deepEqual(calculateMissionReward(mission('m15', 15)), {
      missionId: 'm15', points: 15, isFinalMission: false,
    });
    assert.equal(calculateMissionReward(mission('final_01', 100), true).points, 100);
  });

  test('separates normal and final mission phase rules', () => {
    assert.equal(canCompleteMission('DAY1_ACTIVE', false), true);
    assert.equal(canCompleteMission('FINAL_MISSION', false), false);
    assert.equal(canCompleteMission('FINAL_MISSION', true), true);
    assert.equal(canCompleteMission('DAY1_ACTIVE', true), false);
  });

  test('duplicate predicate compares only the supplied IDs', () => {
    assert.equal(isSameMissionId('m01', 'm01'), true);
    assert.equal(isSameMissionId('m01', 'm02'), false);
    assert.equal(isSameMissionId('m01', null), false);
  });
});

describe('mission scoring', () => {
  for (const [points, expected] of [[15, 15], [50, 50], [100, 100]]) {
    test(`${points} point mission produces equal team and player deltas`, () => {
      const result = calculateMissionScore(mission(`m${points}`, points), 0.5);
      assert.equal(result.teamScoreDelta, expected);
      assert.equal(result.playerScoreDelta, expected);
    });
  }

  for (const randomValue of [0.00, 0.10, 0.199999]) {
    test(`random ${randomValue} awards one invincible card`, () => {
      assert.equal(calculateMissionScore(mission('m01', 15), randomValue).invincibleCardDelta, 1);
      assert.equal(calculateMissionScore(mission('m01', 15), randomValue).luckyReward, true);
    });
  }

  for (const randomValue of [0.20, 0.50]) {
    test(`random ${randomValue} awards no invincible card`, () => {
      assert.equal(calculateMissionScore(mission('m01', 15), randomValue).invincibleCardDelta, 0);
      assert.equal(calculateMissionScore(mission('m01', 15), randomValue).luckyReward, false);
    });
  }
});
