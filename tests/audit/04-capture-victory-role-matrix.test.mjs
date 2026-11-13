import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveCapture } from '../../src/game/capture.ts';
import { determineGameWinner } from '../../src/game/scoring.ts';
import { resolveAdminRoleSwap } from '../../src/game/adminGameState.ts';
import {
  getServerNowMs,
  resetServerClockForTest,
  setServerTimeOffsetMsForTest,
} from '../../src/infrastructure/firebase/serverClock.ts';
import {
  RulePermissionError,
  createActiveParticipantDb,
  incrementSentinel,
} from './helpers/rulesContractHarness.mjs';

describe('Audit 04: Capture Mechanics, Victory Modes, Role Swaps & Clock Skew', () => {
  test('SURVIVAL capture marks target CAPTURED without role swap and awards +50pt', () => {
    const { db, sessionId } = createActiveParticipantDb({
      config: { victoryMode: 'SURVIVAL', teamARole: 'RUNNER', teamBRole: 'ONI' },
    });
    db.seed('users/oniB', { id: 'oniB', name: 'Oni B', role: 'ONI', team: 'B', color: '#3b82f6', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });
    db.seed('users/runA1', { id: 'runA1', name: 'Run A1', role: 'RUNNER', team: 'A', color: '#ef4444', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0, protectionZone: 'NONE' });
    db.seed('users/runA2', { id: 'runA2', name: 'Run A2', role: 'RUNNER', team: 'A', color: '#ef4444', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });

    const capture = resolveCapture({
      captorId: 'oniB',
      targetId: 'runA1',
      players: [
        { id: 'oniB', team: 'B', status: 'ACTIVE', invincibleCards: 0 },
        { id: 'runA1', team: 'A', status: 'ACTIVE', invincibleCards: 0, protectionZone: 'NONE' },
        { id: 'runA2', team: 'A', status: 'ACTIVE', invincibleCards: 0 },
      ],
      teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
      phase: 'DAY1_ACTIVE',
      now: db.serverNowMs,
      victoryMode: 'SURVIVAL',
    });
    assert.equal(capture.allowed, true);

    db.commitBatch([
      {
        type: 'update',
        path: 'game_config/current',
        data: {
          teamARole: capture.teamRoles.teamARole,
          teamBRole: capture.teamRoles.teamBRole,
          lastCaptureTargetId: 'runA1',
          teamBScore: incrementSentinel(50),
          logs: [{ id: 'c1', timestamp: db.serverNowMs, message: 'Team B captured A1', type: 'CAPTURE' }],
        },
      },
      ...capture.playerChanges.map(ch => ({
        type: 'update',
        path: `users/${ch.playerId}`,
        data: {
          status: ch.status,
          waitingUntil: ch.waitingUntil,
          ...(ch.invincibleUntil !== undefined ? { invincibleUntil: ch.invincibleUntil } : {}),
        },
      })),
    ], { uid: 'oniB', signInProvider: 'password' });

    assert.equal(db.rawGet('users/runA1').status, 'CAPTURED');
    assert.equal(db.rawGet('users/runA2').status, 'ACTIVE');
    assert.equal(db.rawGet('game_config/current').teamBScore, 50);
    assert.equal(db.rawGet('game_config/current').teamARole, 'RUNNER');
  });

  test('SCORE_SWAP capture flips roles across multi-player teams, preserves EMERGENCY/RETIRED, and passes rules', () => {
    const { db, sessionId } = createActiveParticipantDb({
      config: { victoryMode: 'SCORE_SWAP', teamARole: 'RUNNER', teamBRole: 'ONI', captureWaitMinutes: 45 },
    });
    const players = [
      { id: 'oniB1', team: 'B', status: 'ACTIVE', invincibleCards: 0 },
      { id: 'oniB2', team: 'B', status: 'WAITING', invincibleCards: 2 },
      { id: 'oniB_sos', team: 'B', status: 'EMERGENCY', invincibleCards: 0 },
      { id: 'runA1', team: 'A', status: 'ACTIVE', invincibleCards: 1, protectionZone: 'NONE' },
      { id: 'runA2', team: 'A', status: 'WAITING', invincibleCards: 0 },
      { id: 'runA_ret', team: 'A', status: 'RETIRED', invincibleCards: 0 },
    ];
    for (const p of players) {
      db.seed(`users/${p.id}`, { ...p, name: p.id, role: p.team === 'B' ? 'ONI' : 'RUNNER', color: '#000', score: 0, gameSessionId: sessionId });
    }

    const capture = resolveCapture({
      captorId: 'oniB1',
      targetId: 'runA1',
      players,
      teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
      phase: 'DAY2_ACTIVE',
      now: db.serverNowMs,
      victoryMode: 'SCORE_SWAP',
      captureWaitDurationMs: 45 * 60_000,
    });
    assert.equal(capture.allowed, true);
    assert.equal(capture.playerChanges.length, 4);

    db.commitBatch([
      {
        type: 'update',
        path: 'game_config/current',
        data: {
          teamARole: capture.teamRoles.teamARole,
          teamBRole: capture.teamRoles.teamBRole,
          lastCaptureTargetId: 'runA1',
          nextRevealTime: capture.nextRevealTime,
          teamBScore: incrementSentinel(50),
          logs: [{ id: 'c-swap', timestamp: db.serverNowMs, message: 'Swap!', type: 'CAPTURE' }],
        },
      },
      ...capture.playerChanges.map(ch => ({
        type: 'update',
        path: `users/${ch.playerId}`,
        data: {
          status: ch.status,
          waitingUntil: ch.waitingUntil,
          ...(ch.invincibleUntil !== undefined ? { invincibleUntil: ch.invincibleUntil } : {}),
          ...(ch.invincibleCardsDelta !== 0 ? { invincibleCards: incrementSentinel(ch.invincibleCardsDelta) } : {}),
        },
      })),
    ], { uid: 'oniB1', signInProvider: 'password' });

    assert.equal(db.rawGet('game_config/current').teamARole, 'ONI');
    assert.equal(db.rawGet('game_config/current').teamBRole, 'RUNNER');
    assert.equal(db.rawGet('users/runA1').status, 'WAITING');
    assert.equal(db.rawGet('users/oniB1').invincibleCards, 1);
    assert.equal(db.rawGet('users/oniB2').status, 'ACTIVE');
    assert.equal(db.rawGet('users/oniB2').invincibleCards, 3);
    assert.equal(db.rawGet('users/oniB_sos').status, 'EMERGENCY');
    assert.equal(db.rawGet('users/runA_ret').status, 'RETIRED');
  });

  test('[AUDIT-BUG] server-synced clock prevents ONI lock check from firing early when client clock is ahead of Firestore server time', () => {
    const startTime = 1_750_000_000_000;
    // Server time is at 29m55s after startTime; Client clock is 10 seconds fast (30m05s).
    const serverNow = startTime + 1_795_000;
    const clientNow = startTime + 1_805_000;
    const { db, sessionId } = createActiveParticipantDb({
      serverNowMs: serverNow,
      config: { startTime, victoryMode: 'SURVIVAL' },
    });
    db.seed('users/oniB', { id: 'oniB', name: 'Oni B', role: 'ONI', team: 'B', color: '#3b82f6', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });
    db.seed('users/runA', { id: 'runA', name: 'Run A', role: 'RUNNER', team: 'A', color: '#ef4444', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });

    try {
      setServerTimeOffsetMsForTest(serverNow - clientNow);
      const syncedNow = getServerNowMs(clientNow);
      assert.equal(syncedNow, serverNow);

      // Before 30m elapses on the server, synced clock keeps ONI lock active:
      const lockedCapture = resolveCapture({
        captorId: 'oniB',
        targetId: 'runA',
        players: [
          { id: 'oniB', team: 'B', status: 'ACTIVE', invincibleCards: 0 },
          { id: 'runA', team: 'A', status: 'ACTIVE', invincibleCards: 0 },
        ],
        teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
        phase: 'DAY1_ACTIVE',
        startTime,
        now: syncedNow,
        victoryMode: 'SURVIVAL',
      });
      assert.equal(lockedCapture.allowed, false);
      assert.equal(lockedCapture.reason, 'ONI_INITIAL_LOCK');

      // Once 30m passes on server, synced clock allows capture AND firestore.rules accepts it:
      db.advanceServerTime(10_000);
      const unlockedSyncedNow = getServerNowMs(clientNow + 10_000);
      const capture = resolveCapture({
        captorId: 'oniB',
        targetId: 'runA',
        players: [
          { id: 'oniB', team: 'B', status: 'ACTIVE', invincibleCards: 0 },
          { id: 'runA', team: 'A', status: 'ACTIVE', invincibleCards: 0 },
        ],
        teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
        phase: 'DAY1_ACTIVE',
        startTime,
        now: unlockedSyncedNow,
        victoryMode: 'SURVIVAL',
      });
      assert.equal(capture.allowed, true);

      db.commitBatch([
        {
          type: 'update',
          path: 'game_config/current',
          data: {
            lastCaptureTargetId: 'runA',
            teamBScore: incrementSentinel(50),
            logs: [{ id: 'c1', timestamp: unlockedSyncedNow, message: 'Capture', type: 'CAPTURE' }],
          },
        },
        { type: 'update', path: 'users/runA', data: { status: 'CAPTURED', waitingUntil: 0, invincibleUntil: 0 } },
      ], { uid: 'oniB', signInProvider: 'password' });
      assert.equal(db.rawGet('users/runA').status, 'CAPTURED');
    } finally {
      resetServerClockForTest();
    }
  });

  for (const blockedZone of ['GREEN_CAR', 'SAFE_ZONE']) {
    test(`rejects capture when target is protected by ${blockedZone}`, () => {
      const res = resolveCapture({
        captorId: 'oniB',
        targetId: 'runA',
        players: [
          { id: 'oniB', team: 'B', status: 'ACTIVE', invincibleCards: 0 },
          { id: 'runA', team: 'A', status: 'ACTIVE', invincibleCards: 0, protectionZone: blockedZone },
        ],
        teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
        phase: 'DAY1_ACTIVE',
        now: 1_750_000_000_000,
      });
      assert.equal(res.allowed, false);
      assert.equal(res.reason, 'TARGET_PROTECTION_ZONE');
    });
  }

  for (const blockedStatus of ['WAITING', 'CAPTURED', 'EMERGENCY', 'RETIRED']) {
    test(`rejects capture when target status is ${blockedStatus}`, () => {
      const res = resolveCapture({
        captorId: 'oniB',
        targetId: 'runA',
        players: [
          { id: 'oniB', team: 'B', status: 'ACTIVE', invincibleCards: 0 },
          { id: 'runA', team: 'A', status: blockedStatus, invincibleCards: 0 },
        ],
        teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
        phase: 'DAY1_ACTIVE',
        now: 1_750_000_000_000,
      });
      assert.equal(res.allowed, false);
      assert.equal(res.reason, 'TARGET_STATUS');
    });
  }

  for (const blockedPhase of ['PRE_GAME', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_PAUSED', 'GAME_OVER']) {
    test(`rejects capture during non-active phase ${blockedPhase}`, () => {
      const res = resolveCapture({
        captorId: 'oniB',
        targetId: 'runA',
        players: [
          { id: 'oniB', team: 'B', status: 'ACTIVE', invincibleCards: 0 },
          { id: 'runA', team: 'A', status: 'ACTIVE', invincibleCards: 0 },
        ],
        teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
        phase: blockedPhase,
        now: 1_750_000_000_000,
      });
      assert.equal(res.allowed, false);
      assert.equal(res.reason, 'PHASE');
    });
  }

  test('determineGameWinner handles SURVIVAL vs SCORE_SWAP victory rules correctly', () => {
    // SURVIVAL: Team A is RUNNER, 1 active runner remaining -> RUNNER team (A) wins even if B has higher score!
    assert.equal(determineGameWinner({
      victoryMode: 'SURVIVAL',
      teamAScore: 10,
      teamBScore: 500,
      teamARole: 'RUNNER',
      teamBRole: 'ONI',
      players: [
        { team: 'A', status: 'CAPTURED' },
        { team: 'A', status: 'ACTIVE' },
        { team: 'B', status: 'ACTIVE' },
      ],
    }), 'A');

    // SURVIVAL: All runners captured/retired -> ONI team (B) wins!
    assert.equal(determineGameWinner({
      victoryMode: 'SURVIVAL',
      teamAScore: 500,
      teamBScore: 0,
      teamARole: 'RUNNER',
      teamBRole: 'ONI',
      players: [
        { team: 'A', status: 'CAPTURED' },
        { team: 'A', status: 'RETIRED' },
        { team: 'B', status: 'ACTIVE' },
      ],
    }), 'B');

    // SCORE_SWAP: Team with higher score wins regardless of surviving runners
    assert.equal(determineGameWinner({
      victoryMode: 'SCORE_SWAP',
      teamAScore: 150,
      teamBScore: 150,
      teamARole: 'RUNNER',
      teamBRole: 'ONI',
      players: [{ team: 'A', status: 'ACTIVE' }],
    }), 'DRAW');
  });

  test('[AUDIT-BUG] SURVIVAL mode winner when there are 0 runners registered declares ONI winner automatically', () => {
    const winner = determineGameWinner({
      victoryMode: 'SURVIVAL',
      teamAScore: 100,
      teamBScore: 0,
      teamARole: 'RUNNER',
      teamBRole: 'ONI',
      players: [{ team: 'B', status: 'ACTIVE' }],
    });
    assert.equal(winner, 'B');
  });

  test('[AUDIT-BUG] Admin swapTeamRoles leaves SURVIVAL CAPTURED players stuck in CAPTURED even if switched to ONI or new round', () => {
    const swap = resolveAdminRoleSwap({
      teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
      players: [
        { id: 'a1', team: 'A', status: 'CAPTURED' },
        { id: 'b1', team: 'B', status: 'ACTIVE' },
      ],
      now: 1_750_000_000_000,
    });
    assert.equal(swap.allowed, true);
    const a1Change = swap.playerChanges.find(c => c.playerId === 'a1');
    assert.ok(
      a1Change,
      '[AUDIT-BUG] resolveAdminRoleSwap ignores CAPTURED players (`status !== ACTIVE && status !== WAITING`), so after switching from SURVIVAL to SCORE_SWAP or forcing role swap, previously CAPTURED Team A players become ONI team members stuck in CAPTURED status!',
    );
  });
});
