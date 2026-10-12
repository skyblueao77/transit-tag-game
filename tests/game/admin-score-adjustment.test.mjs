import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveTeamScoreAdjustment } from '../../src/game/adminScoreAdjustment.ts';

const base = { team: 'A', delta: 5, reasonCode: 'CORRECTION', currentTeamAScore: 20, currentTeamBScore: 30 };

describe('trusted team score adjustment core', () => {
  test('applies signed integer deltas to only the selected team and allows exact zero', () => {
    for (const team of ['A', 'B']) {
      const decision = resolveTeamScoreAdjustment({ ...base, team });
      assert.equal(decision.allowed, true);
      assert.equal(decision.scoreField, team === 'A' ? 'teamAScore' : 'teamBScore');
      assert.equal(decision.previousScore, team === 'A' ? 20 : 30);
      assert.equal(decision.nextScore, (team === 'A' ? 20 : 30) + 5);
    }
    assert.equal(resolveTeamScoreAdjustment({ ...base, delta: -20 }).nextScore, 0);
    assert.equal(resolveTeamScoreAdjustment({ ...base, team: 'B', delta: -10 }).nextScore, 20);
  });

  test('accepts every fixed reason code without deriving display text in the Core', () => {
    for (const reasonCode of ['CORRECTION', 'BONUS', 'PENALTY', 'OTHER']) {
      const result = resolveTeamScoreAdjustment({ ...base, reasonCode });
      assert.equal(result.allowed, true);
      assert.equal(result.reasonCode, reasonCode);
    }
  });

  test('rejects invalid delta, team, reason and malformed trusted scores', () => {
    for (const delta of [0, 1.5, NaN, Infinity, -1001, 1001, '2', true, undefined]) {
      assert.deepEqual(resolveTeamScoreAdjustment({ ...base, delta }), { allowed: false, reason: 'INVALID_DELTA' });
    }
    assert.deepEqual(resolveTeamScoreAdjustment({ ...base, team: 'ADMIN' }), { allowed: false, reason: 'INVALID_TEAM' });
    assert.deepEqual(resolveTeamScoreAdjustment({ ...base, reasonCode: 'FREE_TEXT' }), { allowed: false, reason: 'INVALID_REASON_CODE' });
    for (const score of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10']) {
      assert.deepEqual(resolveTeamScoreAdjustment({ ...base, currentTeamAScore: score }), { allowed: false, reason: 'INVALID_CURRENT_SCORE' });
      assert.deepEqual(resolveTeamScoreAdjustment({ ...base, currentTeamBScore: score }), { allowed: false, reason: 'INVALID_CURRENT_SCORE' });
    }
  });

  test('rejects below-zero and unsafe resulting scores', () => {
    assert.deepEqual(resolveTeamScoreAdjustment({ ...base, delta: -21 }), { allowed: false, reason: 'SCORE_BELOW_ZERO' });
    assert.deepEqual(resolveTeamScoreAdjustment({ ...base, currentTeamAScore: Number.MAX_SAFE_INTEGER, delta: 1 }), { allowed: false, reason: 'UNSAFE_RESULT' });
  });

  test('does not mutate caller input and leaves the unselected score unchanged', () => {
    const input = { ...base, currentTeamBScore: 30 };
    const before = structuredClone(input);
    const result = resolveTeamScoreAdjustment(input);
    assert.deepEqual(input, before);
    assert.equal(result.allowed && result.scoreField === 'teamAScore' ? input.currentTeamBScore : -1, 30);
  });
});
