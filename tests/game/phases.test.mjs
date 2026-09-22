import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canCapture,
  canScore,
  canUpdateLocation,
  canUsePowerup,
  isGameActive,
  isGamePaused,
} from '../../src/game/phases.ts';

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

  test('pausing blocks the existing gameplay actions', () => {
    const actions = [canScore, canCapture, canUsePowerup, canUpdateLocation];
    for (const action of actions) {
      assert.equal(action('DAY1_PAUSED'), false);
      assert.equal(action('DAY2_PAUSED'), false);
      assert.equal(action('DAY1_ACTIVE'), true);
    }
  });
});
