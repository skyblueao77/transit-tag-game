import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { revealPlayerLocations } from '../src/application/adminReveal.ts';

const input = { scope: 'TEAM_A', durationMinutes: 10, requestId: 'retry-key' };
const success = {
  ok: true,
  scope: 'TEAM_A',
  expiresAt: 1_800_000_600_000,
  projectedCount: 3,
  skippedCount: 2,
  duplicate: false,
};

describe('Admin Reveal application use case', () => {
  test('forwards only scope, duration, and requestId and preserves trusted result', async () => {
    const calls = [];
    const gateway = {
      revealPlayerLocations: async intent => {
        calls.push(structuredClone(intent));
        return success;
      },
    };
    assert.deepEqual(await revealPlayerLocations(input, gateway), success);
    assert.deepEqual(calls, [input]);
  });

  test('forwards duplicate results and server domain rejection unchanged', async () => {
    const duplicate = { ...success, duplicate: true };
    assert.deepEqual(await revealPlayerLocations(input, {
      revealPlayerLocations: async () => duplicate,
    }), duplicate);
    const rejected = { ok: false, reason: 'ZERO_VALID_LOCATIONS' };
    assert.deepEqual(await revealPlayerLocations(input, {
      revealPlayerLocations: async () => rejected,
    }), rejected);
  });

  test('maps transport exceptions to a persistence failure', async () => {
    assert.deepEqual(await revealPlayerLocations(input, {
      revealPlayerLocations: async () => { throw new Error('offline'); },
    }), { ok: false, reason: 'PERSISTENCE_ERROR' });
  });
});
