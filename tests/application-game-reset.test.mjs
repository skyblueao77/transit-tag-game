import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { executeGameReset, prepareGameReset } from '../src/application/gameReset.ts';

const preview = {
  confirmationToken: 'token', expiresAt: 1000, currentSessionId: null, proposedSessionId: 'proposed',
  sessionSchemaVersion: 0, participantCount: 2, privateLocationCount: 1,
  exposedLocationCount: 0, emergencyProjectionCount: 1, estimatedWriteCount: 7,
  resetReady: false, warningCodes: ['SESSION_SCOPE_NOT_READY'],
};

describe('game reset application use cases', () => {
  test('forwards an empty prepare intent and returns the safe preview result', async () => {
    const received = [];
    const result = { ok: true, preview };
    assert.deepEqual(await prepareGameReset({}, { prepareGameReset: async input => { received.push(input); return result; } }), result);
    assert.deepEqual(received, [{}]);
  });

  test('forwards only confirmation token and request ID, and maps server readiness rejection', async () => {
    const received = [];
    const input = { confirmationToken: 'token', requestId: 'request' };
    const rejected = { ok: false, reason: 'RESET_NOT_READY' };
    assert.deepEqual(await executeGameReset(input, { executeGameReset: async value => { received.push(value); return rejected; } }), rejected);
    assert.deepEqual(received, [input]);
    assert.deepEqual(Object.keys(received[0]).sort(), ['confirmationToken', 'requestId']);
    assert.deepEqual(await executeGameReset(input, { executeGameReset: async () => ({ ok: false, reason: 'CONFIRMATION_STALE' }) }), { ok: false, reason: 'CONFIRMATION_STALE' });
  });

  test('maps transport failures for both operations', async () => {
    const failed = { ok: false, reason: 'PERSISTENCE_ERROR' };
    assert.deepEqual(await prepareGameReset({}, { prepareGameReset: async () => { throw Error('network'); } }), failed);
    assert.deepEqual(await executeGameReset({ confirmationToken: 't', requestId: 'r' }, { executeGameReset: async () => { throw Error('network'); } }), failed);
  });
});
