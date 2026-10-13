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
  test('forwards the subscribed Session for Preview and returns the safe result', async () => {
    const received = [];
    const result = { ok: true, preview };
    const input = { expectedSessionId: 'current-session' };
    assert.deepEqual(await prepareGameReset(input, { prepareGameReset: async value => { received.push(value); return result; } }), result);
    assert.deepEqual(received, [input]);
  });

  test('forwards confirmation token, request ID, and Session; execution remains disabled', async () => {
    const received = [];
    const input = { confirmationToken: 'token', requestId: 'request', expectedSessionId: 'current-session' };
    const rejected = { ok: false, reason: 'RESET_NOT_READY' };
    assert.deepEqual(await executeGameReset(input, { executeGameReset: async value => { received.push(value); return rejected; } }), rejected);
    assert.deepEqual(received, [input]);
    assert.deepEqual(Object.keys(received[0]).sort(), ['confirmationToken', 'expectedSessionId', 'requestId']);
    assert.deepEqual(await executeGameReset(input, { executeGameReset: async () => ({ ok: false, reason: 'CONFIRMATION_STALE' }) }), { ok: false, reason: 'CONFIRMATION_STALE' });
  });

  test('maps transport failures for both operations', async () => {
    const failed = { ok: false, reason: 'PERSISTENCE_ERROR' };
    assert.deepEqual(await prepareGameReset({}, { prepareGameReset: async () => { throw Error('network'); } }), failed);
    assert.deepEqual(await executeGameReset({ confirmationToken: 't', requestId: 'r' }, { executeGameReset: async () => { throw Error('network'); } }), failed);
  });
});
