import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transitionGamePhase } from '../src/application/adminPhaseActions.ts';
test('forwards semantic action/requestId and maps errors', async () => {
  const input = { action:'PAUSE', requestId:'id' }; let received;
  const expected = { ok:true, action:'PAUSE', oldPhase:'DAY1_ACTIVE', newPhase:'DAY1_PAUSED', duplicate:false };
  assert.deepEqual(await transitionGamePhase(input, { transitionGamePhase: async value => { received=value; return expected; } }), expected);
  assert.deepEqual(received, input);
  assert.deepEqual(await transitionGamePhase(input, { transitionGamePhase: async () => { throw Error(); } }), { ok:false, reason:'PERSISTENCE_ERROR' });
});
