import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildResetReceiptContract,
  isResetConfirmationExpired,
  isResetConfirmationStale,
  isResetSessionReady,
  planFutureGameResetConfig,
  planFuturePlayerReset,
  planGameResetPreview,
  resolveResetReceiptReplay,
  RESET_MAX_ESTIMATED_WRITES,
  RESET_SESSION_SCHEMA_VERSION,
  validateExecuteGameResetRequest,
  validatePrepareGameResetRequest,
  validateResetConfig,
} from '../../src/game/gameReset.ts';

const uuid = '123e4567-e89b-42d3-a456-426614174000';
const config = { gameStatus: 'PRE_GAME', teamAScore: 0, teamBScore: 0, logs: [] };
const doc = (id, team, revision = '1') => ({ id, team, revision });
const identity = (id, revision = '1') => ({ id, revision });

function preview(overrides = {}) {
  return planGameResetPreview({
    config,
    participants: [doc('a1', 'A'), doc('b1', 'B'), doc('admin', 'ADMIN'), doc('unknown', 'X')],
    privateLocations: [identity('a1'), identity('admin'), identity('unknown')],
    exposedLocations: [identity('b1')],
    emergencyProjections: [identity('b1'), identity('outside')],
    ...overrides,
  });
}

describe('trusted game reset foundation core', () => {
  test('treats missing Session fields as legacy and rejects malformed Session metadata', () => {
    assert.deepEqual(validateResetConfig(config), { allowed: true, session: { currentSessionId: null, sessionSchemaVersion: 0 } });
    assert.deepEqual(validateResetConfig({ ...config, sessionSchemaVersion: 1, gameSessionId: uuid }).session, {
      currentSessionId: uuid, sessionSchemaVersion: 1,
    });
    assert.equal(validateResetConfig({ ...config, sessionSchemaVersion: 2 }).allowed, false);
    assert.equal(validateResetConfig({ ...config, gameSessionId: 'legacy' }).allowed, false);
    assert.equal(validateResetConfig({ ...config, logs: {} }).allowed, false);
    assert.equal(validateResetConfig({ ...config, teamAScore: '0' }).allowed, false);
  });

  test('filters only A/B participants and their linked location documents, returning no profile data', () => {
    const input = {
      config,
      participants: [
        { ...doc('a1', 'A'), name: 'private name' }, doc('b1', 'B'), doc('admin', 'ADMIN'), doc('unknown', 'X'),
      ],
      privateLocations: [identity('a1'), identity('admin'), identity('unknown')],
      exposedLocations: [identity('b1')],
      emergencyProjections: [identity('b1'), identity('outside')],
    };
    const before = structuredClone(input);
    const result = planGameResetPreview(input);
    assert.equal(result.participantCount, 2);
    assert.equal(result.privateLocationCount, 1);
    assert.equal(result.exposedLocationCount, 1);
    assert.equal(result.emergencyProjectionCount, 1);
    assert.deepEqual(result.participantIds, ['a1', 'b1']);
    assert.equal(JSON.stringify(result).includes('private name'), false);
    assert.deepEqual(input, before);
  });

  test('calculates the future write count and enforces 450 while accepting the boundary', () => {
    const atLimit = planGameResetPreview({ config, participants: Array.from({ length: 447 }, (_, i) => doc(`u${i}`, 'A')), privateLocations: [], exposedLocations: [], emergencyProjections: [] });
    const tooLarge = planGameResetPreview({ config, participants: Array.from({ length: 448 }, (_, i) => doc(`u${i}`, 'A')), privateLocations: [], exposedLocations: [], emergencyProjections: [] });
    assert.equal(atLimit.estimatedWriteCount, RESET_MAX_ESTIMATED_WRITES);
    assert.equal(atLimit.tooLarge, false);
    assert.equal(tooLarge.estimatedWriteCount, 451);
    assert.equal(tooLarge.tooLarge, true);
    assert.ok(tooLarge.warningCodes.includes('RESET_TOO_LARGE'));
  });

  test('validates strict Prepare and Execute request contracts without mutation', () => {
    const execute = { confirmationToken: uuid, requestId: '123e4567-e89b-42d3-a456-426614174001', expectedSessionId: uuid };
    const before = structuredClone(execute);
    assert.deepEqual(validatePrepareGameResetRequest({ expectedSessionId: uuid }), {
      allowed: true, request: { expectedSessionId: uuid },
    });
    assert.deepEqual(validatePrepareGameResetRequest({ expectedSessionId: uuid, extra: true }), { allowed: false, reason: 'INVALID_ARGUMENT' });
    assert.deepEqual(validatePrepareGameResetRequest({}), { allowed: false, reason: 'INVALID_ARGUMENT' });
    assert.deepEqual(validateExecuteGameResetRequest(execute), { allowed: true, request: execute });
    assert.deepEqual(validateExecuteGameResetRequest({ ...execute, currentSessionId: 'forged' }), { allowed: false, reason: 'INVALID_ARGUMENT' });
    assert.deepEqual(validateExecuteGameResetRequest({ confirmationToken: 'bad', requestId: execute.requestId, expectedSessionId: uuid }), { allowed: false, reason: 'INVALID_ARGUMENT' });
    assert.deepEqual(execute, before);
  });

  test('reports Session readiness only for version 2 and later', () => {
    assert.equal(RESET_SESSION_SCHEMA_VERSION, 2);
    assert.equal(isResetSessionReady(0), false);
    assert.equal(isResetSessionReady(1), false);
    assert.equal(isResetSessionReady(2), true);
  });

  test('expires at the exact deadline and marks count, Session, or fingerprint changes stale', () => {
    assert.equal(isResetConfirmationExpired(500, 499), false);
    assert.equal(isResetConfirmationExpired(500, 500), true);
    const plan = preview();
    const confirmation = {
      currentSessionId: plan.currentSessionId,
      sessionSchemaVersion: plan.sessionSchemaVersion,
      participantCount: plan.participantCount,
      privateLocationCount: plan.privateLocationCount,
      exposedLocationCount: plan.exposedLocationCount,
      emergencyProjectionCount: plan.emergencyProjectionCount,
      estimatedWriteCount: plan.estimatedWriteCount,
      fingerprint: 'same-fingerprint',
    };
    assert.equal(isResetConfirmationStale(confirmation, plan, 'same-fingerprint'), false);
    assert.equal(isResetConfirmationStale(confirmation, plan, 'changed-fingerprint'), true);
    assert.equal(isResetConfirmationStale({ ...confirmation, participantCount: 3 }, plan, 'same-fingerprint'), true);
  });

  test('defines future Config and Player normalization plans without mutating input', () => {
    const configInput = { proposedSessionId: uuid, resetAt: 100, nextRevealTime: 200 };
    const before = structuredClone(configInput);
    assert.deepEqual(planFutureGameResetConfig(configInput), {
      gameStatus: 'PRE_GAME', day: 1, teamAScore: 0, teamBScore: 0, missionMode: 'DIFFERENT',
      activeMissionA: null, activeMissionB: null, activeFinalMissionId: null, isFinalMissionActive: false,
      isGameOver: false, startTime: 0, finalMissionEndTime: 0, teamARole: 'RUNNER', teamBRole: 'ONI',
      broadcastMessage: '', broadcastTime: 0, gameSessionId: uuid, sessionStartedAt: 100,
      sessionSchemaVersion: 2, nextRevealTime: 200,
      clearRevealDeadlines: ['locationRevealUntil', 'teamARevealUntil', 'teamBRevealUntil'], preserveLogCount: 199,
    });
    assert.deepEqual(configInput, before);
    assert.deepEqual(planFuturePlayerReset(), {
      status: 'ACTIVE', score: 0, invincibleCards: 0, invincibleUntil: 0, waitingUntil: 0, shinkansenStartTime: null,
    });
  });

  test('defines a strict future receipt contract and rejects requestId reuse', () => {
    const receipt = buildResetReceiptContract(uuid, uuid, uuid);
    assert.equal(receipt.operation, 'executeGameReset');
    assert.equal(resolveResetReceiptReplay(receipt, uuid, uuid), 'MATCH');
    assert.equal(resolveResetReceiptReplay(receipt, uuid, '123e4567-e89b-42d3-a456-426614174001'), 'REQUEST_ID_REUSED');
    assert.equal(resolveResetReceiptReplay({}, uuid, uuid), 'INVALID_RECEIPT');
    assert.equal(buildResetReceiptContract('bad', uuid, uuid), null);
  });
});
