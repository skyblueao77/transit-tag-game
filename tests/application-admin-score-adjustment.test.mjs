import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { adjustTeamScore } from '../src/application/adminScoreAdjustment.ts';

const input = { team: 'B', delta: -4, reasonCode: 'PENALTY', requestId: 'request-id' };

describe('admin score adjustment application action', () => {
  test('forwards only the intent and returns the trusted server result', async () => {
    const received = [];
    const result = { ok: true, team: 'B', delta: -4, reasonCode: 'PENALTY', previousScore: 8, nextScore: 4, duplicate: false };
    assert.deepEqual(await adjustTeamScore(input, { adjustTeamScore: async value => { received.push(value); return result; } }), result);
    assert.deepEqual(received, [input]);
    assert.deepEqual(Object.keys(received[0]).sort(), ['delta', 'reasonCode', 'requestId', 'team']);
  });

  test('forwards duplicate results, domain rejections, and maps transport errors', async () => {
    const duplicate = { ok: true, team: 'B', delta: -4, reasonCode: 'PENALTY', previousScore: 8, nextScore: 4, duplicate: true };
    assert.deepEqual(await adjustTeamScore(input, { adjustTeamScore: async () => duplicate }), duplicate);
    assert.deepEqual(await adjustTeamScore(input, { adjustTeamScore: async () => ({ ok: false, reason: 'SCORE_BELOW_ZERO' }) }), { ok: false, reason: 'SCORE_BELOW_ZERO' });
    assert.deepEqual(await adjustTeamScore(input, { adjustTeamScore: async () => { throw Error('transport'); } }), { ok: false, reason: 'PERSISTENCE_ERROR' });
  });
});
