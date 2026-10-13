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
const config = { gameStatus: 'DAY1_ACTIVE', gameSessionId: sessionIds[0], sessionStartedAt: now, sessionSchemaVersion: 2, teamAScore: 5, teamBScore: 9, logs: [{ id: 'prior' }] };
const requestId = '323e4567-e89b-42d3-a456-426614174000';

function makeFixture({ admin = true, gameConfig = config, participants, collections, failWrite = false } = {}) {
  const state = {
    admin,
    config: gameConfig === null ? null : structuredClone(gameConfig),
    configRevision: 'config-revision-1',
    participants: structuredClone(participants ?? [
      { id: 'player-a', team: 'A', revision: 'a1', name: 'private player name' },
      { id: 'player-b', team: 'B', revision: 'b1' },
      { id: 'admin-player', team: 'ADMIN', revision: 'x1' },
      { id: 'unknown', team: 'OTHER', revision: 'y1' },
    ]),
    collections: structuredClone(collections ?? {
      privateLocations: [{ id: 'player-a', revision: 'p1', data: { latitude: 35, longitude: 139 } }],
      exposedLocations: [{ id: 'player-b', revision: 'e1', data: { latitude: 36, longitude: 140 } }],
      emergencyLocationProjections: [{ id: 'player-b', revision: 'm1', data: { latitude: 37, longitude: 141 } }],
    }),
    confirmations: new Map(),
    writes: [],
    reads: [],
    failWrite,
    queue: Promise.resolve(),
  };
  const store = {
    runTransaction: async work => {
      let release;
      const previous = state.queue;
      state.queue = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        const pending = [];
        const tx = {
          readAdmin: async actor => { state.reads.push('admin'); return actor === uid && state.admin; },
          readConfig: async () => { state.reads.push('config'); return state.config === null ? null : { data: structuredClone(state.config), revision: state.configRevision }; },
          readParticipants: async () => { state.reads.push('participants'); return structuredClone(state.participants); },
          readCollection: async name => { state.reads.push(`collection:${name}`); return structuredClone(state.collections[name]); },
          readConfirmation: async (actor, token) => { state.reads.push('confirmation'); return structuredClone(state.confirmations.get(`${actor}:${token}`) ?? null); },
          createConfirmation: (actor, token, confirmation) => {
            state.writes.push(`confirmation:${actor}:${token}`);
            pending.push(() => state.confirmations.set(`${actor}:${token}`, structuredClone(confirmation)));
          },
        };
        const result = await work(tx);
        if (state.failWrite && pending.length > 0) throw new Error('storage failure');
        pending.forEach(apply => apply());
        return result;
      } finally {
        release();
      }
    },
  };
  let tokenIndex = 0;
  let sessionIndex = 0;
  const runtime = {
    calls: { now: 0, token: 0, session: 0 },
    now() { this.calls.now += 1; return now; },
    createTokenId() { this.calls.token += 1; return tokenIds[tokenIndex++]; },
    createProposedSessionId() { this.calls.session += 1; return sessionIds[sessionIndex++]; },
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
      assert.deepEqual(fixture.state.reads, reason === 'INVALID_ARGUMENT' ? [] : ['admin', 'config']);
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
      assert.deepEqual(fixture.state.reads, ['admin', 'config']);
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
      proposedSessionId: sessionIds[0],
      sessionSchemaVersion: 2,
      participantCount: 2,
      privateLocationCount: 1,
      exposedLocationCount: 1,
      emergencyProjectionCount: 1,
      estimatedWriteCount: 8,
      resetReady: false,
      warningCodes: [],
    });
    assert.equal(JSON.stringify(result).includes('private player name'), false);
    assert.equal(JSON.stringify(result).includes('latitude'), false);
    const receipt = fixture.state.confirmations.get(`${uid}:${tokenIds[0]}`);
    assert.equal(receipt.actorUid, uid);
    assert.equal(receipt.currentSessionId, sessionIds[0]);
    assert.equal(receipt.proposedSessionId, sessionIds[0]);
    assert.equal(receipt.used, false);
    assert.equal(receipt.previewFingerprint.length, 64);
    assert.deepEqual(fixture.runtime.calls, { now: 1, token: 1, session: 1 });
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
      assert.deepEqual(fixture.state.reads, ['admin', 'config', 'confirmation']);
      assert.deepEqual(fixture.state.writes, []);
    }
  });

  test('execute remains RESET_NOT_READY for a matching current Session and writes no state', async () => {
    for (const session of [{}]) {
      const fixture = makeFixture({ gameConfig: { ...config, ...session } });
      await prepare(fixture);
      const configBefore = structuredClone(fixture.state.config);
      const participantsBefore = structuredClone(fixture.state.participants);
      const collectionsBefore = structuredClone(fixture.state.collections);
      const tokenBefore = structuredClone(fixture.state.confirmations.get(`${uid}:${tokenIds[0]}`));
      fixture.state.writes.length = 0;
      await rejects('RESET_NOT_READY', () => execute(fixture, tokenIds[0]));
      assert.deepEqual(fixture.state.config, configBefore);
      assert.deepEqual(fixture.state.participants, participantsBefore);
      assert.deepEqual(fixture.state.collections, collectionsBefore);
      assert.deepEqual(fixture.state.confirmations.get(`${uid}:${tokenIds[0]}`), tokenBefore);
      assert.deepEqual(fixture.state.writes, []);
      assert.equal(fixture.state.confirmations.size, 1);
    }
  });
});
