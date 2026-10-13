import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  executeGameResetForAdmin,
  GameResetServiceError,
  prepareGameResetForAdmin,
} from '../lib/functions/src/admin/gameResetService.js';

const uid = 'trusted-admin';
const now = 1_800_000_000_000;
const tokenIds = [
  '123e4567-e89b-42d3-a456-426614174000',
  '123e4567-e89b-42d3-a456-426614174001',
  '123e4567-e89b-42d3-a456-426614174002',
  '123e4567-e89b-42d3-a456-426614174003',
];
const sessionIds = [
  '223e4567-e89b-42d3-a456-426614174000',
  '223e4567-e89b-42d3-a456-426614174001',
  '223e4567-e89b-42d3-a456-426614174002',
  '223e4567-e89b-42d3-a456-426614174003',
];
const proposedSessionIds = [
  '523e4567-e89b-42d3-a456-426614174000',
  '523e4567-e89b-42d3-a456-426614174001',
  '523e4567-e89b-42d3-a456-426614174002',
  '523e4567-e89b-42d3-a456-426614174003',
];
const config = { gameStatus: 'DAY1_ACTIVE', gameSessionId: sessionIds[0], sessionStartedAt: now, sessionSchemaVersion: 2, teamAScore: 5, teamBScore: 9, logs: [{ id: 'prior' }] };
const requestId = '323e4567-e89b-42d3-a456-426614174000';

function makeFixture({ admin = true, gameConfig = config, participants, collections, failWrite = false, retryTransactionOnce = false } = {}) {
  const state = {
    admin,
    config: gameConfig === null ? null : structuredClone(gameConfig),
    configRevision: 'config-revision-1',
    participants: structuredClone(participants ?? [
      { id: 'player-a', team: 'A', revision: 'a1', name: 'private player name', status: 'EMERGENCY', score: 10 },
      { id: 'player-b', team: 'B', revision: 'b1', status: 'CAPTURED', score: 20 },
      { id: 'admin-player', team: 'ADMIN', revision: 'x1', status: 'ACTIVE', score: 99 },
      { id: 'unknown', team: 'OTHER', revision: 'y1', status: 'ACTIVE', score: 88 },
    ]),
    collections: structuredClone(collections ?? {
      privateLocations: [{ id: 'player-a', revision: 'p1', data: { latitude: 35, longitude: 139 } }, { id: 'admin-player', revision: 'p2', data: {} }],
      exposedLocations: [{ id: 'player-b', revision: 'e1', data: { latitude: 36, longitude: 140 } }],
      emergencyLocationProjections: [{ id: 'player-b', revision: 'm1', data: { latitude: 37, longitude: 141 } }],
    }),
    confirmations: new Map(),
    receipts: new Map(),
    missionCompletions: [{ id: 'historical-completion', gameSessionId: sessionIds[0] }],
    writes: [],
    reads: [],
    failWrite,
    retryTransactionOnce,
    queue: Promise.resolve(),
  };
  const store = {
    runTransaction: async work => {
      let release;
      const previous = state.queue;
      state.queue = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        const runAttempt = async () => {
          const pending = [];
          const writeLabels = [];
          const tx = {
            readAdmin: async actor => { state.reads.push('admin'); return actor === uid && state.admin; },
            readConfig: async () => { state.reads.push('config'); return state.config === null ? null : { data: structuredClone(state.config), revision: state.configRevision }; },
            readParticipants: async () => { state.reads.push('participants'); return structuredClone(state.participants); },
            readCollection: async name => { state.reads.push(`collection:${name}`); return structuredClone(state.collections[name]); },
            readConfirmation: async (actor, token) => { state.reads.push('confirmation'); return structuredClone(state.confirmations.get(`${actor}:${token}`) ?? null); },
            readResetReceipt: async (actor, id) => { state.reads.push('receipt'); return structuredClone(state.receipts.get(`${actor}:${id}`) ?? null); },
            createConfirmation: (actor, token, confirmation) => {
              writeLabels.push(`confirmation:${actor}:${token}`);
              pending.push(() => state.confirmations.set(`${actor}:${token}`, structuredClone(confirmation)));
            },
            writeReset: commit => {
              writeLabels.push('config', ...commit.participantIds.map(id => `player:${id}`));
              for (const [name, ids] of Object.entries(commit.locationIds)) {
                writeLabels.push(...ids.map(id => `delete:${name}:${id}`));
              }
              writeLabels.push(`confirmation-used:${commit.confirmationToken}`, `receipt:${commit.requestId}`);
              pending.push(() => {
                state.config = { ...state.config, ...structuredClone(commit.configPatch) };
                state.configRevision = 'config-revision-reset';
                state.participants = state.participants.map(player => commit.participantIds.includes(player.id)
                  ? { ...player, ...structuredClone(commit.playerPatch) }
                  : player);
                for (const [name, ids] of Object.entries(commit.locationIds)) {
                  state.collections[name] = state.collections[name].filter(document => !ids.includes(document.id));
                }
                const key = `${commit.adminUid}:${commit.confirmationToken}`;
                state.confirmations.set(key, { ...state.confirmations.get(key), used: true, usedAt: commit.completedAt });
                state.receipts.set(`${commit.adminUid}:${commit.requestId}`, structuredClone(commit.receipt));
              });
            },
          };
          const result = await work(tx);
          return { result, pending, writeLabels };
        };
        let attempt = await runAttempt();
        if (state.retryTransactionOnce) {
          state.retryTransactionOnce = false;
          state.reads.push('transaction-retry');
          attempt = await runAttempt();
        }
        if (state.failWrite && attempt.writeLabels.length > 0) throw new Error('storage failure');
        attempt.pending.forEach(apply => apply());
        state.writes.push(...attempt.writeLabels);
        return attempt.result;
      } finally {
        release();
      }
    },
  };
  let tokenIndex = 0;
  let sessionIndex = 0;
  const runtime = {
    calls: { now: 0, token: 0, session: 0, log: 0 },
    now() { this.calls.now += 1; return now; },
    createTokenId() { this.calls.token += 1; return tokenIds[tokenIndex++]; },
    createProposedSessionId() { this.calls.session += 1; return proposedSessionIds[sessionIndex++]; },
    createLogId() { this.calls.log += 1; return '423e4567-e89b-42d3-a456-426614174099'; },
  };
  return { state, store, runtime };
}

async function rejects(reason, callback) {
  await assert.rejects(callback, error => error instanceof GameResetServiceError && error.reason === reason);
}

async function prepare(fixture) {
  return prepareGameResetForAdmin(uid, { expectedSessionId: fixture.state.config?.gameSessionId ?? sessionIds[0] }, fixture.store, fixture.runtime);
}

async function execute(fixture, token, input = { confirmationToken: token, requestId, expectedSessionId: fixture.state.config.gameSessionId }) {
  return executeGameResetForAdmin(uid, input, fixture.store, fixture.runtime);
}

describe('trusted game reset foundation service', () => {
  test('prepare requires authentication, Admin, empty request and valid Config before writing a token', async () => {
    const unauthenticated = makeFixture();
    await rejects('UNAUTHENTICATED', () => prepareGameResetForAdmin('', {}, unauthenticated.store, unauthenticated.runtime));
    const nonAdmin = makeFixture({ admin: false });
    await rejects('PERMISSION_DENIED', () => prepare(nonAdmin));
    await rejects('INVALID_ARGUMENT', () => prepareGameResetForAdmin(uid, { extra: true }, makeFixture().store, makeFixture().runtime));
    const absent = makeFixture({ gameConfig: null });
    await rejects('CONFIG_NOT_FOUND', () => prepare(absent));
    const malformed = makeFixture({ gameConfig: { ...config, sessionSchemaVersion: 1 } });
    await rejects('SESSION_CHANGED', () => prepare(malformed));
    assert.equal(nonAdmin.state.confirmations.size, 0);
    assert.equal(absent.state.confirmations.size, 0);
    assert.equal(malformed.state.confirmations.size, 0);
  });

  test('prepare requires the expected Config Session before reading reset scope or writing a token', async () => {
    const missing = makeFixture();
    await rejects('INVALID_ARGUMENT', () => prepareGameResetForAdmin(uid, {}, missing.store, missing.runtime));
    const malformed = makeFixture();
    await rejects('INVALID_ARGUMENT', () => prepareGameResetForAdmin(uid, { expectedSessionId: 'not-a-session-uuid' }, malformed.store, malformed.runtime));
    assert.deepEqual(missing.state.reads, []);
    assert.deepEqual(malformed.state.reads, []);
    assert.deepEqual(missing.state.writes, []);
    assert.deepEqual(malformed.state.writes, []);

    for (const [gameConfig, reason] of [
      [null, 'CONFIG_NOT_FOUND'],
      [{ ...config, sessionStartedAt: undefined }, 'SESSION_CHANGED'],
      [{ ...config, gameSessionId: 'bad/session' }, 'SESSION_CHANGED'],
      [{ ...config, gameSessionId: undefined }, 'INVALID_CONFIG'],
    ]) {
      const fixture = makeFixture({ gameConfig });
      await rejects(reason, () => prepareGameResetForAdmin(uid, { expectedSessionId: sessionIds[0] }, fixture.store, fixture.runtime));
      assert.deepEqual(fixture.state.reads, ['admin', 'config']);
      assert.deepEqual(fixture.state.writes, []);
    }

    const stale = makeFixture();
    await rejects('SESSION_CHANGED', () => prepareGameResetForAdmin(uid, { expectedSessionId: sessionIds[1] }, stale.store, stale.runtime));
    assert.deepEqual(stale.state.reads, ['admin', 'config']);
    assert.deepEqual(stale.state.writes, []);
  });

  test('execute requires the expected Config Session before reading confirmation or reset scope', async () => {
    for (const [input, reason] of [
      [{ confirmationToken: tokenIds[0], requestId }, 'INVALID_ARGUMENT'],
      [{ confirmationToken: tokenIds[0], requestId, expectedSessionId: 'bad' }, 'INVALID_ARGUMENT'],
      [{ confirmationToken: tokenIds[0], requestId, expectedSessionId: sessionIds[1] }, 'SESSION_CHANGED'],
    ]) {
      const fixture = makeFixture();
      await rejects(reason, () => executeGameResetForAdmin(uid, input, fixture.store, fixture.runtime));
      assert.deepEqual(fixture.state.writes, []);
      assert.deepEqual(fixture.state.reads, reason === 'INVALID_ARGUMENT' ? [] : ['admin', 'receipt', 'config']);
    }

    for (const [gameConfig, reason] of [
      [null, 'CONFIG_NOT_FOUND'],
      [{ ...config, sessionStartedAt: undefined }, 'SESSION_CHANGED'],
      [{ ...config, gameSessionId: 'bad/session' }, 'SESSION_CHANGED'],
      [{ ...config, gameSessionId: undefined }, 'INVALID_CONFIG'],
    ]) {
      const fixture = makeFixture({ gameConfig });
      await rejects(reason, () => executeGameResetForAdmin(uid, {
        confirmationToken: tokenIds[0], requestId, expectedSessionId: sessionIds[0],
      }, fixture.store, fixture.runtime));
      assert.deepEqual(fixture.state.reads, ['admin', 'receipt', 'config']);
      assert.deepEqual(fixture.state.writes, []);
    }
  });

  test('prepare returns privacy-safe A/B counts and stores actor- and Session-bound five-minute token', async () => {
    const fixture = makeFixture();
    const result = await prepare(fixture);
    assert.deepEqual(result, {
      ok: true,
      confirmationToken: tokenIds[0],
      expiresAt: now + 5 * 60 * 1000,
      currentSessionId: sessionIds[0],
      proposedSessionId: proposedSessionIds[0],
      sessionSchemaVersion: 2,
      participantCount: 2,
      privateLocationCount: 1,
      exposedLocationCount: 1,
      emergencyProjectionCount: 1,
      estimatedWriteCount: 8,
      resetReady: true,
      warningCodes: [],
    });
    assert.equal(JSON.stringify(result).includes('private player name'), false);
    assert.equal(JSON.stringify(result).includes('latitude'), false);
    const receipt = fixture.state.confirmations.get(`${uid}:${tokenIds[0]}`);
    assert.equal(receipt.actorUid, uid);
    assert.equal(receipt.currentSessionId, sessionIds[0]);
    assert.equal(receipt.proposedSessionId, proposedSessionIds[0]);
    assert.equal(receipt.used, false);
    assert.equal(receipt.previewFingerprint.length, 64);
    assert.deepEqual(fixture.runtime.calls, { now: 1, token: 1, session: 1, log: 0 });
    const second = await prepare(fixture);
    assert.equal(second.confirmationToken, tokenIds[1]);
    assert.notEqual(second.proposedSessionId, result.proposedSessionId);
    assert.equal(fixture.state.confirmations.size, 2);
  });

  test('prepare marks over-limit preview and maps storage failures without partial token persistence', async () => {
    const tooManyParticipants = Array.from({ length: 448 }, (_, i) => ({ id: `p${i}`, team: 'A', revision: `r${i}` }));
    const large = makeFixture({ participants: tooManyParticipants, collections: { privateLocations: [], exposedLocations: [], emergencyLocationProjections: [] } });
    const preview = await prepare(large);
    assert.equal(preview.estimatedWriteCount, 451);
    assert.ok(preview.warningCodes.includes('RESET_TOO_LARGE'));

    const failing = makeFixture({ failWrite: true });
    await rejects('PERSISTENCE_ERROR', () => prepare(failing));
    assert.equal(failing.state.confirmations.size, 0);
  });

  test('execute validates strict request, Admin, token, actor, expiry, use, Session, stale counts and size', async () => {
    const invalid = makeFixture();
    for (const value of [null, {}, { confirmationToken: tokenIds[0], requestId, extra: true }, { confirmationToken: 'bad', requestId }]) {
      await rejects('INVALID_ARGUMENT', () => executeGameResetForAdmin(uid, value, invalid.store, invalid.runtime));
    }
    const noAdmin = makeFixture({ admin: false });
    await rejects('PERMISSION_DENIED', () => execute(noAdmin, tokenIds[0]));
    const missing = makeFixture();
    await rejects('CONFIRMATION_NOT_FOUND', () => execute(missing, tokenIds[0]));

    const actor = makeFixture();
    await prepare(actor);
    actor.state.confirmations.get(`${uid}:${tokenIds[0]}`).actorUid = 'other-admin';
    await rejects('PERMISSION_DENIED', () => execute(actor, tokenIds[0]));

    const expired = makeFixture();
    await prepare(expired);
    expired.state.confirmations.get(`${uid}:${tokenIds[0]}`).expiresAt = now;
    await rejects('CONFIRMATION_EXPIRED', () => execute(expired, tokenIds[0]));

    const used = makeFixture();
    await prepare(used);
    used.state.confirmations.get(`${uid}:${tokenIds[0]}`).used = true;
    await rejects('CONFIRMATION_ALREADY_USED', () => execute(used, tokenIds[0]));

    const changedSession = makeFixture({ gameConfig: { ...config, gameSessionId: sessionIds[2] } });
    await prepare(changedSession);
    changedSession.state.config.gameSessionId = sessionIds[3];
    changedSession.state.configRevision = 'config-revision-2';
    await rejects('SESSION_CHANGED', () => execute(changedSession, tokenIds[0]));

    const stale = makeFixture();
    await prepare(stale);
    stale.state.collections.exposedLocations.push({ id: 'player-a', revision: 'new', data: {} });
    await rejects('CONFIRMATION_STALE', () => execute(stale, tokenIds[0]));
    const changedConfig = makeFixture();
    await prepare(changedConfig);
    changedConfig.state.config.teamAScore += 1;
    changedConfig.state.configRevision = 'config-revision-2';
    await rejects('CONFIRMATION_STALE', () => execute(changedConfig, tokenIds[0]));

    const largeParticipants = Array.from({ length: 448 }, (_, i) => ({ id: `p${i}`, team: 'A', revision: `r${i}` }));
    const large = makeFixture({ participants: largeParticipants, collections: { privateLocations: [], exposedLocations: [], emergencyLocationProjections: [] } });
    await prepare(large);
    await rejects('RESET_TOO_LARGE', () => execute(large, tokenIds[0]));
  });

  test('execute fails closed on mismatched and legacy confirmation Sessions', async () => {
    for (const session of [sessionIds[1], undefined]) {
      const fixture = makeFixture();
      await prepare(fixture);
      const confirmation = fixture.state.confirmations.get(`${uid}:${tokenIds[0]}`);
      if (session === undefined) delete confirmation.currentSessionId;
      else confirmation.currentSessionId = session;
      fixture.state.reads.length = 0;
      fixture.state.writes.length = 0;
      await rejects(session === undefined ? 'PERSISTENCE_ERROR' : 'SESSION_CHANGED', () => execute(fixture, tokenIds[0]));
      assert.deepEqual(fixture.state.reads, ['admin', 'receipt', 'config', 'confirmation']);
      assert.deepEqual(fixture.state.writes, []);
    }
  });

  test('executes reset atomically, binds A/B Players to a new Session, cleans locations, and preserves history', async () => {
    const fixture = makeFixture();
    await prepare(fixture);
    const previousCompletions = structuredClone(fixture.state.missionCompletions);
    fixture.state.writes.length = 0;
    const result = await execute(fixture, tokenIds[0]);

    assert.deepEqual(result, { ok: true, executed: true, newSessionId: proposedSessionIds[0] });
    assert.equal(fixture.state.config.gameSessionId, proposedSessionIds[0]);
    assert.equal(fixture.state.config.sessionSchemaVersion, 2);
    assert.equal(fixture.state.config.sessionStartedAt, now);
    assert.equal(fixture.state.config.gameStatus, 'PRE_GAME');
    assert.equal(fixture.state.config.teamAScore, 0);
    assert.equal(fixture.state.config.teamBScore, 0);
    assert.equal(fixture.state.config.activeMissionA, null);
    assert.equal(fixture.state.config.activeMissionB, null);
    assert.equal(fixture.state.config.locationRevealUntil, null);
    assert.equal(fixture.state.config.logs[0].actorUid, uid);
    assert.equal(fixture.state.config.logs[0].gameSessionId, proposedSessionIds[0]);

    for (const id of ['player-a', 'player-b']) {
      const player = fixture.state.participants.find(value => value.id === id);
      assert.equal(player.gameSessionId, proposedSessionIds[0]);
      assert.equal(player.status, 'ACTIVE');
      assert.equal(player.score, 0);
      assert.equal(player.invincibleCards, 0);
      assert.equal(player.invincibleUntil, 0);
      assert.equal(player.waitingUntil, 0);
      assert.equal(player.shinkansenStartTime, null);
    }
    assert.equal(fixture.state.participants.find(value => value.id === 'admin-player').score, 99);
    assert.equal(fixture.state.participants.find(value => value.id === 'unknown').score, 88);
    assert.deepEqual(fixture.state.collections.privateLocations.map(value => value.id), ['admin-player']);
    assert.deepEqual(fixture.state.collections.exposedLocations, []);
    assert.deepEqual(fixture.state.collections.emergencyLocationProjections, []);
    assert.deepEqual(fixture.state.missionCompletions, previousCompletions);
    assert.equal(fixture.state.confirmations.get(`${uid}:${tokenIds[0]}`).used, true);

    const receipt = fixture.state.receipts.get(`${uid}:${requestId}`);
    assert.equal(receipt.gameSessionId, config.gameSessionId);
    assert.equal(receipt.confirmationToken, tokenIds[0]);
    assert.deepEqual(receipt.result, result);
    assert.equal(fixture.state.writes.length, 8);
  });

  test('replays the same request stably after Session change and rejects old-session new requests', async () => {
    const fixture = makeFixture();
    await prepare(fixture);
    const first = await execute(fixture, tokenIds[0]);
    const stateAfterReset = {
      config: structuredClone(fixture.state.config),
      participants: structuredClone(fixture.state.participants),
      collections: structuredClone(fixture.state.collections),
      confirmation: structuredClone(fixture.state.confirmations.get(`${uid}:${tokenIds[0]}`)),
      receipt: structuredClone(fixture.state.receipts.get(`${uid}:${requestId}`)),
    };
    fixture.state.reads.length = 0;
    fixture.state.writes.length = 0;

    const replay = await execute(fixture, tokenIds[0], {
      confirmationToken: tokenIds[0], requestId, expectedSessionId: config.gameSessionId,
    });
    assert.deepEqual(replay, first);
    assert.deepEqual(fixture.state.reads, ['admin', 'receipt']);
    assert.deepEqual(fixture.state.writes, []);
    assert.deepEqual(fixture.state.config, stateAfterReset.config);
    assert.deepEqual(fixture.state.participants, stateAfterReset.participants);
    assert.deepEqual(fixture.state.collections, stateAfterReset.collections);
    assert.deepEqual(fixture.state.confirmations.get(`${uid}:${tokenIds[0]}`), stateAfterReset.confirmation);

    const staleRequest = {
      confirmationToken: tokenIds[0],
      requestId: tokenIds[1],
      expectedSessionId: config.gameSessionId,
    };
    await rejects('SESSION_CHANGED', () => execute(fixture, tokenIds[0], staleRequest));
    assert.deepEqual(fixture.state.writes, []);
    assert.deepEqual(fixture.state.receipts.get(`${uid}:${requestId}`), stateAfterReset.receipt);
  });

  test('rejects legacy or cross-Session request receipts and reused tokens without writes', async () => {
    const fixture = makeFixture();
    fixture.state.receipts.set(`${uid}:${requestId}`, {
      operation: 'executeGameReset', requestId, confirmationToken: tokenIds[0],
      result: { ok: true, executed: true, newSessionId: sessionIds[1] },
    });
    await rejects('REQUEST_ID_REUSED', () => execute(fixture, tokenIds[0]));
    assert.deepEqual(fixture.state.writes, []);

    fixture.state.receipts.clear();
    fixture.state.receipts.set(`${uid}:${requestId}`, {
      operation: 'executeGameReset', requestId, gameSessionId: sessionIds[1],
      confirmationToken: tokenIds[0], createdAt: now,
      result: { ok: true, executed: true, newSessionId: sessionIds[1] },
    });
    await rejects('SESSION_CHANGED', () => execute(fixture, tokenIds[0]));
    assert.deepEqual(fixture.state.writes, []);
  });

  test('rejects oversized execution before any write and rolls back persistence failures', async () => {
    const largeParticipants = Array.from({ length: 448 }, (_, i) => ({ id: `p${i}`, team: 'A', revision: `r${i}` }));
    const large = makeFixture({ participants: largeParticipants, collections: { privateLocations: [], exposedLocations: [], emergencyLocationProjections: [] } });
    await prepare(large);
    large.state.writes.length = 0;
    await rejects('RESET_TOO_LARGE', () => execute(large, tokenIds[0]));
    assert.deepEqual(large.state.writes, []);
    assert.equal(large.state.config.gameSessionId, sessionIds[0]);

    const failing = makeFixture();
    await prepare(failing);
    const before = {
      config: structuredClone(failing.state.config),
      participants: structuredClone(failing.state.participants),
      collections: structuredClone(failing.state.collections),
      confirmation: structuredClone(failing.state.confirmations.get(`${uid}:${tokenIds[0]}`)),
    };
    failing.state.failWrite = true;
    await rejects('PERSISTENCE_ERROR', () => execute(failing, tokenIds[0]));
    assert.deepEqual(failing.state.config, before.config);
    assert.deepEqual(failing.state.participants, before.participants);
    assert.deepEqual(failing.state.collections, before.collections);
    assert.deepEqual(failing.state.confirmations.get(`${uid}:${tokenIds[0]}`), before.confirmation);
    assert.equal(failing.state.receipts.size, 0);
  });

  test('holds generated time and audit ID constant across transaction retries', async () => {
    const fixture = makeFixture({ retryTransactionOnce: true });
    await prepare(fixture);
    fixture.state.retryTransactionOnce = true;
    fixture.state.reads.length = 0;
    fixture.state.writes.length = 0;
    const result = await execute(fixture, tokenIds[0]);
    assert.equal(result.newSessionId, proposedSessionIds[0]);
    assert.equal(fixture.runtime.calls.log, 1);
    assert.equal(fixture.runtime.calls.now, 2);
    assert.equal(fixture.state.config.logs[0].id, '423e4567-e89b-42d3-a456-426614174099');
    assert.equal(fixture.state.receipts.get(`${uid}:${requestId}`).createdAt, now);
    assert.equal(fixture.state.writes.length, 8);
  });
});
