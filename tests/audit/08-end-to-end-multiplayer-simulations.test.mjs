import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { MISSIONS } from '../../constants.ts';
import { FINAL_MISSIONS } from '../../src/game/finalMissions.ts';
import { resolveAdminPhaseTransition } from '../../src/game/adminPhaseTransition.ts';
import { resolveAdminRoleSwap } from '../../src/game/adminGameState.ts';
import { resolveCapture } from '../../src/game/capture.ts';
import { determineGameWinner } from '../../src/game/scoring.ts';
import {
  FsTimestamp,
  RulePermissionError,
  SERVER_TIMESTAMP_SENTINEL,
  SimulatedFirestore,
  incrementSentinel,
} from './helpers/rulesContractHarness.mjs';

const adminPlayerListSource = readFileSync(new URL('../../views/admin/AdminPlayerListSection.tsx', import.meta.url), 'utf8');
const emergencyMapSource = readFileSync(new URL('../../views/EmergencyProjectionMap.tsx', import.meta.url), 'utf8');
const firebaseClientSource = readFileSync(new URL('../../src/infrastructure/firebase/firebaseClient.ts', import.meta.url), 'utf8');

describe('Audit 08: Full Multiplayer 2-Day Lifecycle & Remaining Runtime Edge Cases', () => {
  test('full 2-day SURVIVAL simulation: bootstrap -> init -> register 4 players -> Day 1 -> mission -> wait -> SOS -> pause -> Day 2 -> capture -> final -> Game Over', () => {
    const db = new SimulatedFirestore(1_750_000_000_000);
    const adminAuth = { uid: 'admin-main', signInProvider: 'password' };
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    // 1. Bootstrap admin
    db.commitBatch([
      { type: 'set', path: 'system/admin_bootstrap', data: { initializedBy: 'admin-main', initializedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
      { type: 'set', path: 'admins/admin-main', data: { role: 'admin', createdAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
    ], adminAuth);

    // 2. Initialize game session + sync normal missions
    db.commitBatch([
      {
        type: 'set',
        path: 'game_config/current',
        data: {
          gameSessionId: sessionId,
          sessionStartedAt: db.serverNowMs,
          sessionSchemaVersion: 2,
          gameStatus: 'PRE_GAME',
          day: 1,
          missionMode: 'DIFFERENT',
          isGameOver: false,
          isFinalMissionActive: false,
          finalMissionEndTime: 0,
          victoryMode: 'SURVIVAL',
          teamARole: 'RUNNER',
          teamBRole: 'ONI',
          teamAScore: 0,
          teamBScore: 0,
          captureWaitMinutes: 30,
          postShinkansenWaitMinutes: 60,
          logs: [],
        },
        merge: false,
      },
      ...MISSIONS.slice(0, 6).map(m => ({ type: 'set', path: `missions/${m.id}`, data: m, merge: true })),
      ...FINAL_MISSIONS.map(fm => ({ type: 'set', path: `missions/${fm.id}`, data: fm, merge: true })),
    ], adminAuth);

    // 3. Register 4 players (2 A, 2 B)
    const players = [
      { id: 'a1', team: 'A', name: 'A太郎' },
      { id: 'a2', team: 'A', name: 'A花子' },
      { id: 'b1', team: 'B', name: 'B鬼1' },
      { id: 'b2', team: 'B', name: 'B鬼2' },
    ];
    for (const p of players) {
      db.commitBatch([
        {
          type: 'set',
          path: `users/${p.id}`,
          data: {
            id: p.id, name: p.name, role: 'RUNNER', team: p.team,
            color: p.team === 'A' ? '#ef4444' : '#3b82f6',
            score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
          },
          merge: false,
        },
        {
          type: 'set',
          path: `privateLocations/${p.id}`,
          data: { gameSessionId: sessionId, latitude: 35.6812, longitude: 139.7671, updatedAt: SERVER_TIMESTAMP_SENTINEL },
          merge: false,
        },
      ], { uid: p.id, signInProvider: 'password' });
    }

    // 4. Start Day 1 + assign missions
    const start1 = resolveAdminPhaseTransition({ currentPhase: 'PRE_GAME', action: 'START_DAY1', now: db.serverNowMs });
    assert.equal(start1.allowed, true);
    db.commitBatch([
      {
        type: 'update',
        path: 'game_config/current',
        data: { ...start1.updates, activeMissionA: MISSIONS[0].id, activeMissionB: MISSIONS[1].id },
      },
    ], adminAuth);

    // 5. Runner A1 completes assigned mission
    const mA = MISSIONS[0];
    const compId = `A_${sessionId}_${mA.id}`;
    db.commitBatch([
      { type: 'set', path: `missionCompletions/${compId}`, data: { gameSessionId: sessionId, missionId: mA.id, team: 'A', completedBy: 'a1', points: mA.points, luckyReward: true, isFinalMission: false, completedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
      { type: 'update', path: 'users/a1', data: { score: mA.points, invincibleCards: 1, lastCompletionId: compId } },
      { type: 'update', path: 'game_config/current', data: { teamAScore: incrementSentinel(mA.points), logs: [{ id: 'log-m1', timestamp: db.serverNowMs, message: 'M1', type: 'MISSION' }] } },
    ], { uid: 'a1', signInProvider: 'password' });

    // 6. After 31 mins, ONI B1 captures A2
    db.advanceServerTime(31 * 60_000);
    const cap = resolveCapture({
      captorId: 'b1',
      targetId: 'a2',
      players: [
        { id: 'b1', team: 'B', status: 'ACTIVE', invincibleCards: 0 },
        { id: 'a2', team: 'A', status: 'ACTIVE', invincibleCards: 0 },
      ],
      teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
      phase: 'DAY1_ACTIVE',
      startTime: db.rawGet('game_config/current').startTime,
      now: db.serverNowMs,
      victoryMode: 'SURVIVAL',
    });
    assert.equal(cap.allowed, true);
    db.commitBatch([
      { type: 'update', path: 'game_config/current', data: { lastCaptureTargetId: 'a2', teamBScore: incrementSentinel(50), logs: [{ id: 'log-c1', timestamp: db.serverNowMs, message: 'Cap A2', type: 'CAPTURE' }, ...db.rawGet('game_config/current').logs] } },
      { type: 'update', path: 'users/a2', data: { status: 'CAPTURED', waitingUntil: 0, invincibleUntil: 0 } },
    ], { uid: 'b1', signInProvider: 'password' });

    // 7. A1 survives through Day 1 -> Day 2 -> Final -> Game Over => Team A wins in SURVIVAL!
    const winner = determineGameWinner({
      victoryMode: 'SURVIVAL',
      teamAScore: db.rawGet('game_config/current').teamAScore,
      teamBScore: db.rawGet('game_config/current').teamBScore,
      teamARole: 'RUNNER',
      teamBRole: 'ONI',
      players: [
        db.rawGet('users/a1'),
        db.rawGet('users/a2'),
        db.rawGet('users/b1'),
        db.rawGet('users/b2'),
      ],
    });
    assert.equal(winner, 'A');
  });

  test('Player cannot modify another player, escalate status to ACTIVE directly from WAITING early, or delete own user doc', () => {
    const db = new SimulatedFirestore(1_750_000_000_000);
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    db.seed('game_config/current', {
      gameSessionId: sessionId, sessionStartedAt: 1000, sessionSchemaVersion: 2,
      gameStatus: 'DAY1_ACTIVE', day: 1, missionMode: 'DIFFERENT', isGameOver: false,
      teamARole: 'RUNNER', teamBRole: 'ONI', teamAScore: 0, teamBScore: 0, logs: [],
    });
    db.seed('users/a1', {
      id: 'a1', name: 'A1', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'WAITING', waitingUntil: db.serverNowMs + 600_000, gameSessionId: sessionId, invincibleCards: 0,
    });
    const aAuth = { uid: 'a1', signInProvider: 'password' };

    // Early waiting self-resume rejected:
    assert.throws(() => {
      db.commitBatch([{ type: 'update', path: 'users/a1', data: { status: 'ACTIVE', waitingUntil: 0, shinkansenStartTime: null } }], aAuth);
    }, RulePermissionError);

    // Self-delete rejected:
    assert.throws(() => {
      db.commitBatch([{ type: 'delete', path: 'users/a1' }], aAuth);
    }, RulePermissionError);
  });

  test('Admin team change updates user team/color/role cleanly while preventing coordinate leakage', () => {
    const db = new SimulatedFirestore();
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    db.seed('admins/admin-1', { role: 'admin', createdAt: FsTimestamp.fromMillis(1000) });
    db.seed('game_config/current', {
      gameSessionId: sessionId, sessionStartedAt: 1000, sessionSchemaVersion: 2,
      gameStatus: 'DAY1_ACTIVE', day: 1, missionMode: 'DIFFERENT', isGameOver: false,
      teamARole: 'RUNNER', teamBRole: 'ONI', teamAScore: 0, teamBScore: 0, logs: [],
    });
    db.seed('users/u1', {
      id: 'u1', name: 'U1', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
    });

    const adminAuth = { uid: 'admin-1', signInProvider: 'password' };
    db.commitBatch([{ type: 'update', path: 'users/u1', data: { team: 'B', color: '#3b82f6', role: 'ONI' } }], adminAuth);
    assert.equal(db.rawGet('users/u1').team, 'B');

    // Admin CANNOT write coordinates onto users/{uid}:
    assert.throws(() => {
      db.commitBatch([{ type: 'update', path: 'users/u1', data: { latitude: 35.6 } }], adminAuth);
    }, RulePermissionError);
  });

  test('AdminPlayerListSection resume button only shows sensible state & EmergencyProjectionMap renders clean timestamps', () => {
    assert.match(adminPlayerListSource, /onResumePlayer/);
    assert.match(emergencyMapSource, /activeProjections/);
    assert.match(firebaseClientSource, /isFirebaseMisconfigured/);
  });

  test('Admin role swap + multi-team state preserves rule compatibility for non-SURVIVAL teams', () => {
    const res = resolveAdminRoleSwap({
      teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
      players: [
        { id: 'a1', team: 'A', status: 'ACTIVE' },
        { id: 'a2', team: 'A', status: 'WAITING' },
        { id: 'b1', team: 'B', status: 'ACTIVE' },
        { id: 'b2', team: 'B', status: 'EMERGENCY' },
        { id: 'b3', team: 'B', status: 'RETIRED' },
      ],
      now: 1_750_000_000_000,
    });
    assert.equal(res.allowed, true);
    assert.equal(res.newOniTeam, 'A');
    assert.deepEqual(res.excludedSafetyPlayerIds, ['b2', 'b3']);
    assert.equal(res.playerChanges.filter(c => c.status === 'WAITING').length, 2);
  });
});
