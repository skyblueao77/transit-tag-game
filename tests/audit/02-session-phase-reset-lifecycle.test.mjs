import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { resolveAdminPhaseTransition } from '../../src/game/adminPhaseTransition.ts';
import {
  isValidGameSessionId,
  sessionScopedCompletionId,
  validateExpectedSession,
  validateGameSession,
} from '../../src/game/gameSession.ts';
import {
  buildResetReceiptContract,
  isResetConfirmationExpired,
  isResetConfirmationStale,
  isValidResetId,
  planFutureGameResetConfig,
  planFuturePlayerReset,
  planGameResetPreview,
  resolveResetReceiptReplay,
  validateExecuteGameResetRequest,
  validatePrepareGameResetRequest,
  validateResetConfig,
} from '../../src/game/gameReset.ts';
import { resolveCapture } from '../../src/game/capture.ts';
import { SimulatedFirestore } from './helpers/rulesContractHarness.mjs';

const adminSessionGatewaySource = readFileSync(
  new URL('../../src/infrastructure/firebase/gateways/adminSessionGateways.ts', import.meta.url),
  'utf8',
);
const sharedSource = readFileSync(
  new URL('../../src/infrastructure/firebase/gateways/shared.ts', import.meta.url),
  'utf8',
);

const ALL_PHASES = [
  'PRE_GAME',
  'DAY1_ACTIVE',
  'DAY1_PAUSED',
  'DAY1_ENDED',
  'DAY2_ACTIVE',
  'DAY2_PAUSED',
  'FINAL_MISSION',
  'GAME_OVER',
];

const ALL_ACTIONS = [
  'START_DAY1',
  'PAUSE',
  'RESUME',
  'END_DAY1',
  'START_DAY2',
  'START_FINAL',
  'END_GAME',
];

const EXPECTED_TRANSITIONS = {
  PRE_GAME: { START_DAY1: 'DAY1_ACTIVE' },
  DAY1_ACTIVE: { PAUSE: 'DAY1_PAUSED', END_DAY1: 'DAY1_ENDED', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  DAY1_PAUSED: { RESUME: 'DAY1_ACTIVE', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  DAY1_ENDED: { START_DAY2: 'DAY2_ACTIVE', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  DAY2_ACTIVE: { PAUSE: 'DAY2_PAUSED', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  DAY2_PAUSED: { RESUME: 'DAY2_ACTIVE', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  FINAL_MISSION: { END_GAME: 'GAME_OVER' },
  GAME_OVER: {},
};

describe('Audit 02: Session Initialization, Phase Transition Matrix & Master Reset', () => {
  // Full 8x7 = 56 phase x action tests!
  for (const phase of ALL_PHASES) {
    for (const action of ALL_ACTIONS) {
      const expectedNext = EXPECTED_TRANSITIONS[phase]?.[action] ?? null;
      test(`phase transition matrix: ${phase} + ${action} -> ${expectedNext ?? 'REJECTED'}`, () => {
        const res = resolveAdminPhaseTransition({
          currentPhase: phase,
          action,
          now: 1_750_000_000_000,
          finalMissionId: action === 'START_FINAL' ? 'final_01' : undefined,
        });
        if (expectedNext) {
          assert.equal(res.allowed, true);
          assert.equal(res.oldPhase, phase);
          assert.equal(res.newPhase, expectedNext);
          assert.equal(res.updates.gameStatus, expectedNext);
        } else {
          assert.equal(res.allowed, false);
          assert.equal(res.reason, 'TRANSITION_NOT_ALLOWED');
        }
      });
    }
  }

  test('START_FINAL rejects missing, empty, or whitespace finalMissionId and invalid now', () => {
    for (const badId of [undefined, null, '', '   ']) {
      const res = resolveAdminPhaseTransition({
        currentPhase: 'DAY2_ACTIVE',
        action: 'START_FINAL',
        now: 1_750_000_000_000,
        finalMissionId: badId,
      });
      assert.equal(res.allowed, false);
      assert.equal(res.reason, 'INVALID_FINAL_MISSION');
    }

    for (const badNow of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = resolveAdminPhaseTransition({
        currentPhase: 'DAY2_ACTIVE',
        action: 'START_FINAL',
        now: badNow,
        finalMissionId: 'final_01',
      });
      assert.equal(res.allowed, false);
      assert.equal(res.reason, 'INVALID_TIME');
    }
  });

  test('[AUDIT-BUG] START_DAY2 resets startTime = now (re-locking ONI for 30m) and PAUSE/RESUME does not track accumulated pause duration', () => {
    const day2Res = resolveAdminPhaseTransition({
      currentPhase: 'DAY1_ENDED',
      action: 'START_DAY2',
      now: 1_750_086_400_000,
    });
    assert.equal(day2Res.allowed, true);
    assert.equal(day2Res.updates.startTime, 1_750_086_400_000);

    const pauseRes = resolveAdminPhaseTransition({
      currentPhase: 'DAY1_ACTIVE',
      action: 'PAUSE',
      now: 1_750_000_600_000,
    });
    assert.ok(
      Object.hasOwn(pauseRes.updates, 'pauseStartTime') || Object.hasOwn(pauseRes.updates, 'totalPausedMs'),
      '[AUDIT-BUG] START_DAY2 resets startTime=now (re-triggering 30m ONI lock) AND PAUSE/RESUME does not track paused duration in game_config, so pausing during the first 30 minutes shrinks effective ONI lock duration!',
    );
  });

  test('[AUDIT-BUG] clientGameSessionInitializationGateway does not guard Firestore 500-write transaction limit when participantCount > 498', () => {
    const manyParticipants = Array.from({ length: 505 }, (_, i) => `p-${i}`);
    const db = new SimulatedFirestore();
    for (const id of manyParticipants) db.seed(`users/${id}`, { id, team: 'A' });
    db.seed('admins/admin-1', { role: 'admin' });
    db.seed('game_config/current', { gameSessionId: '' });

    const ops = [
      { type: 'set', path: 'game_config/current', data: { gameSessionId: '11111111-1111-4111-8111-111111111111', sessionStartedAt: 1000, sessionSchemaVersion: 2 }, merge: true },
      { type: 'set', path: 'admins/admin-1/sessionInitializationRequests/req-1', data: { ok: true }, merge: false },
      ...manyParticipants.map(id => ({ type: 'update', path: `users/${id}`, data: { gameSessionId: '11111111-1111-4111-8111-111111111111' } })),
    ];
    assert.throws(() => db.commitBatch(ops, { uid: 'admin-1', signInProvider: 'password' }), /FIRESTORE_LIMIT_EXCEEDED/);

    const hasRosterTooLargeGuard = adminSessionGatewaySource.includes('ROSTER_TOO_LARGE');
    assert.ok(
      hasRosterTooLargeGuard,
      '[AUDIT-BUG] clientGameSessionInitializationGateway never checks participantRefs.length against Firestore 500-write transaction limit (ROSTER_TOO_LARGE is unguarded), so >498 historical users in DB crashes initializeGameSession!',
    );
  });

  test('[AUDIT-BUG] gameReset rejects valid non-UUID gameSessionId generated by generateSecureId() fallback', () => {
    assert.ok(sharedSource.includes('getRandomValues'), 'Expected fallback in shared.ts');
    const fallbackSessionId = '00112233445566778899aabbccddeeff';
    assert.equal(isValidGameSessionId(fallbackSessionId), true);
    assert.equal(
      isValidResetId(fallbackSessionId),
      true,
      '[AUDIT-BUG] isValidResetId in gameReset.ts strictly requires hyphenated UUID, rejecting valid non-UUID gameSessionId strings from generateSecureId() fallback and blocking master reset!',
    );
  });

  test('validatePrepareGameResetRequest, validateExecuteGameResetRequest & validateResetConfig contracts', () => {
    const validUuid = '11111111-1111-4111-8111-111111111111';
    const tokenUuid = '22222222-2222-4222-8222-222222222222';
    const reqUuid = '33333333-3333-4333-8333-333333333333';

    assert.equal(validatePrepareGameResetRequest({ expectedSessionId: validUuid }).allowed, true);
    assert.equal(validatePrepareGameResetRequest({ expectedSessionId: '' }).allowed, false);
    assert.equal(validateExecuteGameResetRequest({ confirmationToken: tokenUuid, requestId: reqUuid, expectedSessionId: validUuid }).allowed, true);
    assert.equal(validateExecuteGameResetRequest({ confirmationToken: tokenUuid, requestId: reqUuid }).allowed, false);

    assert.equal(validateResetConfig({
      gameStatus: 'DAY1_ACTIVE',
      teamAScore: 10,
      teamBScore: 20,
      gameSessionId: validUuid,
      sessionSchemaVersion: 2,
      sessionStartedAt: 1000,
      logs: [],
    }).allowed, true);
    assert.equal(validateResetConfig({
      gameStatus: 'DAY1_ACTIVE',
      teamAScore: -1,
      teamBScore: 0,
    }).allowed, false);
  });

  test('planGameResetPreview, staleness, TTL & write ceiling (450 writes)', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const config = {
      gameSessionId: sessionId,
      sessionStartedAt: 1000,
      sessionSchemaVersion: 2,
      gameStatus: 'DAY2_PAUSED',
      teamAScore: 50,
      teamBScore: 30,
      logs: [],
    };
    const plan = planGameResetPreview({
      config,
      configRevision: 'rev1',
      participants: [
        { id: 'u1', team: 'A', revision: 'r1' },
        { id: 'u2', team: 'B', revision: 'r2' },
        { id: 'non-team', team: 'ADMIN' },
      ],
      privateLocations: [{ id: 'u1' }, { id: 'orphan' }],
      exposedLocations: [{ id: 'u1' }],
      emergencyProjections: [],
    });
    assert.ok(plan);
    assert.equal(plan.participantCount, 2);
    assert.equal(plan.privateLocationCount, 1);
    assert.equal(plan.estimatedWriteCount, 2 + 1 + 1 + 0 + 3);
    assert.equal(plan.tooLarge, false);

    const snapshot = {
      currentSessionId: plan.currentSessionId,
      sessionSchemaVersion: plan.sessionSchemaVersion,
      participantCount: plan.participantCount,
      privateLocationCount: plan.privateLocationCount,
      exposedLocationCount: plan.exposedLocationCount,
      emergencyProjectionCount: plan.emergencyProjectionCount,
      estimatedWriteCount: plan.estimatedWriteCount,
      fingerprint: 'fp-1',
    };
    assert.equal(isResetConfirmationStale(snapshot, plan, 'fp-1'), false);
    assert.equal(isResetConfirmationStale(snapshot, plan, 'fp-changed'), true);
    assert.equal(isResetConfirmationExpired(2000, 1999), false);
    assert.equal(isResetConfirmationExpired(2000, 2000), true);

    const tooLargePlan = planGameResetPreview({
      config,
      participants: Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, team: 'A' })),
      privateLocations: Array.from({ length: 200 }, (_, i) => ({ id: `u${i}` })),
      exposedLocations: Array.from({ length: 100 }, (_, i) => ({ id: `u${i}` })),
      emergencyProjections: [],
    });
    assert.equal(tooLargePlan.tooLarge, true);
    assert.ok(tooLargePlan.warningCodes.includes('RESET_TOO_LARGE'));
  });

  test('[AUDIT-BUG] executeGameReset hardcodes logs: [] despite planFutureGameResetConfig declaring preserveLogCount: 199', () => {
    const newId = '44444444-4444-4444-8444-444444444444';
    const futurePlan = planFutureGameResetConfig({
      proposedSessionId: newId,
      resetAt: 1_750_000_000_000,
      nextRevealTime: 1_750_000_900_000,
    });
    assert.ok(futurePlan);
    assert.equal(futurePlan.preserveLogCount, 199);

    assert.ok(
      !adminSessionGatewaySource.includes('logs: []'),
      '[AUDIT-BUG] executeGameReset in adminSessionGateways.ts hardcodes `logs: []` (line 673), discarding all history and omitting a reset audit log entry despite planFutureGameResetConfig specifying preserveLogCount: 199!',
    );
  });

  test('validateGameSession, validateExpectedSession, sessionScopedCompletionId & reset receipts', () => {
    assert.equal(validateGameSession(null).valid, false);
    assert.equal(validateGameSession({ gameSessionId: '', sessionStartedAt: 1, sessionSchemaVersion: 2 }).valid, false);
    assert.equal(validateGameSession({ gameSessionId: 's1', sessionStartedAt: -1, sessionSchemaVersion: 2 }).valid, false);
    assert.equal(validateGameSession({ gameSessionId: 's1', sessionStartedAt: 1, sessionSchemaVersion: 1 }).valid, false);
    assert.equal(validateExpectedSession({ gameSessionId: 's1', sessionStartedAt: 1, sessionSchemaVersion: 2 }, 's2').valid, false);
    assert.equal(validateExpectedSession({ gameSessionId: 's1', sessionStartedAt: 1, sessionSchemaVersion: 2 }, 's1').valid, true);
    assert.equal(sessionScopedCompletionId('sess-1', 'A', 'm01'), 'A_sess-1_m01');

    const reqId = '11111111-1111-4111-8111-111111111111';
    const sessId = '22222222-2222-4222-8222-222222222222';
    const token = '33333333-3333-4333-8333-333333333333';
    const newSess = '44444444-4444-4444-8444-444444444444';
    const receipt = buildResetReceiptContract(reqId, sessId, token, newSess);
    assert.ok(receipt);
    assert.equal(resolveResetReceiptReplay(receipt, reqId, sessId, token), 'MATCH');
    assert.equal(resolveResetReceiptReplay(receipt, reqId, '55555555-5555-4555-8555-555555555555', token), 'SESSION_CHANGED');
    assert.equal(resolveResetReceiptReplay(receipt, reqId, sessId, '55555555-5555-4555-8555-555555555555'), 'REQUEST_ID_REUSED');

    const pPatch = planFuturePlayerReset(newSess);
    assert.equal(pPatch?.status, 'ACTIVE');
    assert.equal(pPatch?.score, 0);
  });

  test('ONI initial lock behavior aligns on Day 1 start', () => {
    const res = resolveCapture({
      captorId: 'oni',
      targetId: 'run',
      players: [
        { id: 'oni', team: 'B', status: 'ACTIVE', invincibleCards: 0 },
        { id: 'run', team: 'A', status: 'ACTIVE', invincibleCards: 0 },
      ],
      teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
      phase: 'DAY1_ACTIVE',
      startTime: 1_750_000_000_000,
      now: 1_750_001_799_999,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.reason, 'ONI_INITIAL_LOCK');
  });
});
