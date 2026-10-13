import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GameSessionInitializationError,
  initializeGameSessionForAdmin,
} from '../lib/functions/src/admin/gameSessionService.js';

const uid = 'trusted-admin';
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const now = 1_800_000_000_000;
const legacyConfig = () => ({
  gameStatus: 'DAY1_ACTIVE', teamAScore: 12, teamBScore: 34,
  teamARole: 'ONI', teamBRole: 'RUNNER', logs: [],
  activeMissionA: 'mission-a', unrelated: 'preserved',
});

function fixture({ admin = true, config = legacyConfig(), players = [
  { id: 'player-a', data: { id: 'player-a', team: 'A', score: 9, status: 'ACTIVE' } },
  { id: 'player-b', data: { id: 'player-b', team: 'B', score: 7, status: 'WAITING' } },
] } = {}) {
  const state = { admin, config: structuredClone(config), players: structuredClone(players), receipt: null, writes: [] };
  const store = {
    runTransaction: async work => {
      let pending;
      const tx = {
        readAdmin: async actor => actor === uid && state.admin,
        readReceipt: async () => state.receipt && structuredClone(state.receipt),
        readConfig: async () => state.config && structuredClone(state.config),
        readParticipants: async () => structuredClone(state.players),
        writeInitialization: (actor, data) => {
          pending = { actor, ...structuredClone(data) };
        },
      };
      const result = await work(tx);
      if (pending) {
        if (pending.configPatch) state.config = { ...state.config, ...pending.configPatch };
        for (const id of pending.playerIds) {
          const player = state.players.find(value => value.id === id);
          player.data.gameSessionId = pending.receipt.gameSessionId;
        }
        state.receipt = pending.receipt;
        state.writes.push(pending);
      }
      return result;
    },
  };
  const runtime = {
    now: () => now,
    createSessionId: () => 'session-generated-1',
    createLogId: () => 'log-generated-1',
  };
  return { state, store, runtime };
}

async function rejects(reason, work) {
  await assert.rejects(work, error => error instanceof GameSessionInitializationError && error.reason === reason);
}

describe('trusted game session initialization service', () => {
  test('initializes legacy Config and binds A/B Players, receipt, and audit atomically', async () => {
    const f = fixture();
    const result = await initializeGameSessionForAdmin(uid, { requestId }, f.store, f.runtime);
    assert.deepEqual(result, {
      ok: true, gameSessionId: 'session-generated-1', sessionStartedAt: now,
      sessionSchemaVersion: 2, duplicate: false, alreadyInitialized: false,
    });
    assert.equal(f.state.config.gameSessionId, 'session-generated-1');
    assert.equal(f.state.config.sessionStartedAt, now);
    assert.equal(f.state.config.sessionSchemaVersion, 2);
    assert.equal(f.state.config.gameStatus, 'DAY1_ACTIVE');
    assert.equal(f.state.config.teamAScore, 12);
    assert.equal(f.state.config.activeMissionA, 'mission-a');
    assert.equal(f.state.config.unrelated, 'preserved');
    assert.equal(f.state.config.logs[0].actorUid, uid);
    assert.equal(f.state.config.logs[0].gameSessionId, 'session-generated-1');
    assert.deepEqual(f.state.players.map(player => player.data.gameSessionId), [
      'session-generated-1', 'session-generated-1',
    ]);
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.writes[0].playerIds.length + 2, 4);
    assert.equal(f.state.receipt.operation, 'initializeGameSession');
    assert.equal(f.state.receipt.requestId, requestId);
    assert.equal(f.state.receipt.result.gameSessionId, 'session-generated-1');
  });

  test('same request ID replays stored result without a second write', async () => {
    const f = fixture();
    const first = await initializeGameSessionForAdmin(uid, { requestId }, f.store, f.runtime);
    const replay = await initializeGameSessionForAdmin(uid, { requestId }, f.store, f.runtime);
    assert.deepEqual(replay, { ...first, duplicate: true });
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.config.logs.length, 1);
  });

  test('initialized Session returns no-op and does not mutate Config or Players', async () => {
    const f = fixture({ config: {
      ...legacyConfig(), gameSessionId: 'existing-session',
      sessionStartedAt: now - 1000, sessionSchemaVersion: 2,
    } });
    const beforeConfig = structuredClone(f.state.config);
    const beforePlayers = structuredClone(f.state.players);
    const result = await initializeGameSessionForAdmin(uid, { requestId }, f.store, f.runtime);
    assert.equal(result.alreadyInitialized, true);
    assert.equal(result.gameSessionId, 'existing-session');
    assert.deepEqual(f.state.config, beforeConfig);
    assert.deepEqual(f.state.players, beforePlayers);
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.writes[0].configPatch, undefined);
    assert.deepEqual(f.state.writes[0].playerIds, []);
  });

  test('rejects non-admin, extra request fields, missing Config, and malformed Config/Session fields', async () => {
    const noAdmin = fixture({ admin: false });
    await rejects('PERMISSION_DENIED', () => initializeGameSessionForAdmin(uid, { requestId }, noAdmin.store, noAdmin.runtime));
    const invalidRequest = fixture();
    await rejects('INVALID_ARGUMENT', () => initializeGameSessionForAdmin(uid, { requestId, gameSessionId: 'client-value' }, invalidRequest.store, invalidRequest.runtime));
    const missing = fixture({ config: null });
    await rejects('CONFIG_NOT_FOUND', () => initializeGameSessionForAdmin(uid, { requestId }, missing.store, missing.runtime));
    for (const invalidConfig of [
      { ...legacyConfig(), gameStatus: 'BROKEN' },
      { ...legacyConfig(), teamAScore: '12' },
      { ...legacyConfig(), teamBScore: -1 },
      { ...legacyConfig(), teamARole: 'ADMIN' },
      { ...legacyConfig(), teamBRole: 'ONI' },
      ...[
        { gameSessionId: 'session-only' },
        { sessionStartedAt: now },
        { sessionSchemaVersion: 2 },
        { gameSessionId: 'bad/slash', sessionStartedAt: now, sessionSchemaVersion: 2 },
        { gameSessionId: 'legacy', sessionStartedAt: now, sessionSchemaVersion: 1 },
        { gameSessionId: 'session-valid', sessionStartedAt: 'not-a-time', sessionSchemaVersion: 2 },
      ].map(sessionFields => ({ ...legacyConfig(), ...sessionFields })),
    ]) {
      const malformed = fixture({ config: invalidConfig });
      await rejects('INVALID_CONFIG', () => initializeGameSessionForAdmin(uid, { requestId }, malformed.store, malformed.runtime));
      assert.equal(malformed.state.writes.length, 0);
    }
  });

  test('rejects an oversized A/B roster below Firestore transaction write limits', async () => {
    const players = Array.from({ length: 449 }, (_, index) => ({
      id: `player-${index}`,
      data: { id: `player-${index}`, team: index % 2 === 0 ? 'A' : 'B' },
    }));
    const f = fixture({ players });
    await rejects('ROSTER_TOO_LARGE', () => initializeGameSessionForAdmin(uid, { requestId }, f.store, f.runtime));
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.state.config.gameSessionId, undefined);
  });
});
