import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GAME_SESSION_SCHEMA_VERSION,
  isValidGameSessionId,
  sessionScopedCompletionId,
  validateExpectedSession,
  validateGameSession,
} from '../../src/game/gameSession.ts';

const session = {
  gameSessionId: 'session_2',
  sessionStartedAt: 1_800_000_000_000,
  sessionSchemaVersion: GAME_SESSION_SCHEMA_VERSION,
};

describe('game session Core', () => {
  test('validates complete Session metadata and fails closed for legacy/partial schemas', () => {
    assert.deepEqual(validateGameSession(session), { valid: true, session });
    assert.deepEqual(validateGameSession({}), { valid: false, reason: 'MISSING' });
    for (const malformed of [
      { gameSessionId: 'session_2' },
      { sessionStartedAt: session.sessionStartedAt },
      { sessionSchemaVersion: 2 },
      { ...session, gameSessionId: 'bad/session' },
      { ...session, sessionStartedAt: -1 },
      { ...session, sessionSchemaVersion: 1 },
    ]) assert.deepEqual(validateGameSession(malformed), { valid: false, reason: 'MALFORMED' });
  });

  test('requires exact expected Session and creates deterministic slash-safe Completion IDs', () => {
    assert.equal(isValidGameSessionId('session_2'), true);
    assert.equal(isValidGameSessionId(''), false);
    assert.equal(isValidGameSessionId('bad/session'), false);
    assert.deepEqual(validateExpectedSession(session, 'session_2'), {
      valid: true, gameSessionId: 'session_2',
    });
    assert.deepEqual(validateExpectedSession(session, 'old-session'), {
      valid: false, reason: 'SESSION_CHANGED',
    });
    assert.deepEqual(validateExpectedSession(session, undefined), {
      valid: false, reason: 'SESSION_CHANGED',
    });

    const id = sessionScopedCompletionId('session_2', 'A', 'mission-with-hyphens');
    assert.equal(id, sessionScopedCompletionId('session_2', 'A', 'mission-with-hyphens'));
    assert.doesNotMatch(id, /\//);
    assert.notEqual(id, sessionScopedCompletionId('next-session', 'A', 'mission-with-hyphens'));
    assert.notEqual(id, sessionScopedCompletionId('session_2', 'B', 'mission-with-hyphens'));
  });
});
