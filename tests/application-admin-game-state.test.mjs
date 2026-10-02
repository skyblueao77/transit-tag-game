import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resumePlayer, swapTeamRoles } from '../src/application/adminGameStateActions.ts';

const swapped = {
  ok: true,
  replayed: false,
  teamARole: 'RUNNER',
  teamBRole: 'ONI',
  nextRevealTime: 1_800_001_800_000,
  newOniTeam: 'B',
};

describe('Admin Game State application use cases', () => {
  test('forwards only the role-swap request ID and preserves trusted results/replays', async () => {
    const calls = [];
    const gateway = { swapTeamRoles: async input => { calls.push(structuredClone(input)); return swapped; } };
    assert.deepEqual(await swapTeamRoles({ requestId: 'retry-key' }, gateway), swapped);
    assert.deepEqual(calls, [{ requestId: 'retry-key' }]);

    const replay = { ...swapped, replayed: true };
    assert.deepEqual(await swapTeamRoles({ requestId: 'retry-key' }, {
      swapTeamRoles: async () => replay,
    }), replay);
  });

  test('forwards only targetId and preserves trusted Resume outcome', async () => {
    const calls = [];
    const trusted = { ok: true, resumed: true, status: 'ACTIVE' };
    const gateway = { resumePlayer: async input => { calls.push(structuredClone(input)); return trusted; } };
    assert.deepEqual(await resumePlayer({ targetId: 'player-1' }, gateway), trusted);
    assert.deepEqual(calls, [{ targetId: 'player-1' }]);
  });

  test('preserves server rejection and maps transport exceptions', async () => {
    const rejected = { ok: false, reason: 'PERMISSION_DENIED' };
    assert.deepEqual(await swapTeamRoles({ requestId: 'retry-key' }, {
      swapTeamRoles: async () => rejected,
    }), rejected);
    assert.deepEqual(await resumePlayer({ targetId: 'player-1' }, {
      resumePlayer: async () => ({ ok: false, reason: 'INVALID_STATUS' }),
    }), { ok: false, reason: 'INVALID_STATUS' });
    assert.deepEqual(await swapTeamRoles({ requestId: 'retry-key' }, {
      swapTeamRoles: async () => { throw new Error('offline'); },
    }), { ok: false, reason: 'PERSISTENCE_ERROR' });
    assert.deepEqual(await resumePlayer({ targetId: 'player-1' }, {
      resumePlayer: async () => { throw new Error('offline'); },
    }), { ok: false, reason: 'PERSISTENCE_ERROR' });
  });
});
