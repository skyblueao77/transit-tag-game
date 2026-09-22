import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canCapture,

  canRevealLocation,
  canScore,
  canSendSOS,
  canUpdatePrivateLocation,
  canUsePowerup,
  isGameActive,
  isGamePaused,
} from '../../src/game/phases.ts';
import { canCompleteFinalMission, canCompleteNormalMission } from '../../src/game/missions.ts';

const cases = [
  ['PRE_GAME', false, false],
  ['DAY1_ACTIVE', true, false],
  ['DAY1_PAUSED', false, true],
  ['DAY1_ENDED', false, false],
  ['DAY2_ACTIVE', true, false],
  ['DAY2_PAUSED', false, true],
  ['FINAL_MISSION', true, false],
  ['GAME_OVER', false, false],
];

describe('game phase predicates', () => {
  for (const [status, active, paused] of cases) {
    test(`${status} has the expected active and paused state`, () => {
      assert.equal(isGameActive(status), active);
      assert.equal(isGamePaused(status), paused);
    });
  }

  test('normal missions are allowed only during active day phases', () => {
    assert.equal(canCompleteNormalMission('PRE_GAME'), false);
    assert.equal(canCompleteNormalMission('DAY1_ACTIVE'), true);
    assert.equal(canCompleteNormalMission('DAY1_PAUSED'), false);
    assert.equal(canCompleteNormalMission('DAY1_ENDED'), false);
    assert.equal(canCompleteNormalMission('DAY2_ACTIVE'), true);
    assert.equal(canCompleteNormalMission('DAY2_PAUSED'), false);
    assert.equal(canCompleteNormalMission('FINAL_MISSION'), false);
    assert.equal(canCompleteNormalMission('GAME_OVER'), false);
  });

  test('final missions are allowed only in FINAL_MISSION', () => {
    for (const status of cases.map(([status]) => status)) {
      assert.equal(canCompleteFinalMission(status), status === 'FINAL_MISSION');
    }
  });

  test('scoring, capture, and powerups follow the active gameplay policy', () => {
    for (const [status] of cases) {
      const allowed = status === 'DAY1_ACTIVE' || status === 'DAY2_ACTIVE' || status === 'FINAL_MISSION';
      assert.equal(canScore(status), allowed);
      assert.equal(canCapture(status), allowed);
      assert.equal(canUsePowerup(status), allowed);
    }
  });

  test('public reveal is disabled outside active day phases', () => {
    assert.equal(canRevealLocation('PRE_GAME'), false);
    assert.equal(canRevealLocation('DAY1_ACTIVE'), true);
    assert.equal(canRevealLocation('DAY1_PAUSED'), false);
    assert.equal(canRevealLocation('DAY1_ENDED'), false);
    assert.equal(canRevealLocation('DAY2_ACTIVE'), true);
    assert.equal(canRevealLocation('DAY2_PAUSED'), false);
    assert.equal(canRevealLocation('FINAL_MISSION'), false);
    assert.equal(canRevealLocation('GAME_OVER'), false);
  });

  test('private GPS remains available until GAME_OVER and SOS is always available', () => {
    for (const [status] of cases) {
      assert.equal(canUpdatePrivateLocation(status), status !== 'GAME_OVER');
      assert.equal(canSendSOS(status), true);
    }
  });
});
