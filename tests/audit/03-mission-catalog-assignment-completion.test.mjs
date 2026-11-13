import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { MISSIONS } from '../../constants.ts';
import { FINAL_MISSIONS } from '../../src/game/finalMissions.ts';
import { resolveMissionAssignment } from '../../src/game/adminMission.ts';
import { getUtf8ByteLength, truncateToUtf8Bytes } from '../../src/game/utf8.ts';
import { mapMissionDocuments } from '../../src/infrastructure/firebase/snapshotMappers.ts';
import {
  FsTimestamp,
  RulePermissionError,
  SERVER_TIMESTAMP_SENTINEL,
  createActiveParticipantDb,
  incrementSentinel,
} from './helpers/rulesContractHarness.mjs';

const adminOpsSource = readFileSync(
  new URL('../../src/infrastructure/firebase/gateways/adminOperationsGateways.ts', import.meta.url),
  'utf8',
);
const missionViewSource = readFileSync(
  new URL('../../views/MissionView.tsx', import.meta.url),
  'utf8',
);
const sharedGatewaySource = readFileSync(
  new URL('../../src/infrastructure/firebase/gateways/shared.ts', import.meta.url),
  'utf8',
);

describe('Audit 03: Mission Catalog Sync, Assignment, Custom Missions & Completion Rules', () => {
  test('[AUDIT-BUG] syncMissionCatalog pollutes normal mission assignment pool with FINAL_MISSIONS (100pt final_01..04)', () => {
    // adminOperationsGateways.ts syncMissionCatalog writes MISSIONS + FINAL_MISSIONS into the SAME `missions` collection,
    // and assignMissions reads ALL docs from `missions` without filtering out FINAL_MISSIONS!
    const combinedCatalog = [...MISSIONS, ...FINAL_MISSIONS];
    // Pick random index pointing to final_01..final_04 at end of catalog:
    const finalDraw = 0.99;
    const decision = resolveMissionAssignment({
      phase: 'DAY1_ACTIVE',
      currentMode: 'DIFFERENT',
      catalog: combinedCatalog,
      strategy: 'RANDOM',
      target: 'BOTH',
      randomValues: [finalDraw, 0.0],
    });
    assert.equal(decision.allowed, true);
    assert.ok(
      !decision.selectedMissionIds.some(id => id.startsWith('final_')),
      `[AUDIT-BUG] syncMissionCatalog puts FINAL_MISSIONS into \`missions\`, and assignMissions draws from ALL \`missions\`. Random normal dispatch picked Final Mission(s): ${JSON.stringify(decision.selectedMissionIds)}!`,
    );
  });

  test('[AUDIT-BUG] any Firestore mission doc with `isFinalMission` or custom extra field breaks ALL MANUAL & RANDOM assignMissions', () => {
    // firestore.rules line 570 explicitly checks `mission.isFinalMission == data.isFinalMission`
    // and MissionView.tsx line 88 checks `m?.isFinalMission`!
    const catalogWithFlag = [
      ...MISSIONS,
      { ...FINAL_MISSIONS[0], isFinalMission: true },
    ];
    const decision = resolveMissionAssignment({
      phase: 'DAY1_ACTIVE',
      currentMode: 'DIFFERENT',
      catalog: catalogWithFlag,
      strategy: 'MANUAL',
      target: 'TEAM_A',
      missionId: MISSIONS[0].id,
    });
    assert.equal(
      decision.allowed,
      true,
      `[AUDIT-BUG] hasCanonicalMissionShape rejects ANY mission with \`isFinalMission\` (even though firestore.rules line 570 & MissionView.tsx line 88 use it!), causing catalogIsValid to return false (${decision.reason}) and breaking ALL mission assignments!`,
    );
  });

  test('[AUDIT-BUG] mapMissionDocuments strips isFinalMission from mapped Mission objects', () => {
    const mapped = mapMissionDocuments([
      {
        id: 'final_01',
        data: { ...FINAL_MISSIONS[0], isFinalMission: true },
      },
    ]);
    assert.equal(mapped.length, 1);
    assert.equal(
      mapped[0].isFinalMission,
      true,
      '[AUDIT-BUG] mapMissionDocuments in snapshotMappers.ts omits `isFinalMission`, so MissionView line 88 (`missions.find(m => m?.isFinalMission)`) never finds catalog final missions by flag!',
    );
  });

  test('[AUDIT-BUG] MissionView falls back to FINAL_MISSIONS[0] when activeFinalMissionId is null/deleted, failing firestore.rules', () => {
    const { db, sessionId } = createActiveParticipantDb({
      config: {
        gameStatus: 'FINAL_MISSION',
        isFinalMissionActive: true,
        activeFinalMissionId: null,
      },
    });
    db.seed('users/uA', {
      id: 'uA', name: 'Runner A', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
    });
    db.seed(`missions/${FINAL_MISSIONS[0].id}`, FINAL_MISSIONS[0]);

    // MissionView line 89 computes finalMission = FINAL_MISSIONS[0] when activeFinalMissionId is missing.
    assert.throws(() => {
      db.commitBatch([
        {
          type: 'set',
          path: `missionCompletions/A_${sessionId}_${FINAL_MISSIONS[0].id}`,
          data: {
            gameSessionId: sessionId,
            missionId: FINAL_MISSIONS[0].id,
            team: 'A',
            completedBy: 'uA',
            points: 100,
            luckyReward: false,
            isFinalMission: true,
            completedAt: SERVER_TIMESTAMP_SENTINEL,
          },
          merge: false,
        },
        {
          type: 'update',
          path: 'users/uA',
          data: { score: 100, invincibleCards: 0, lastCompletionId: `A_${sessionId}_${FINAL_MISSIONS[0].id}` },
        },
        {
          type: 'update',
          path: 'game_config/current',
          data: { teamAScore: incrementSentinel(100), logs: [{ id: 'l1', timestamp: db.serverNowMs, message: 'Final', type: 'MISSION' }] },
        },
      ], { uid: 'uA', signInProvider: 'password' });
    }, RulePermissionError);
    assert.doesNotMatch(
      missionViewSource,
      /FINAL_MISSIONS\[0\]/,
      '[AUDIT-BUG] MissionView.tsx line 89 falls back to FINAL_MISSIONS[0] when activeFinalMissionId is null/deleted, presenting a clickable completion UI that ALWAYS fails firestore.rules line 580 with PERMISSION_DENIED!',
    );
  });

  test('valid normal mission completion atomically creates completion, updates player & team score + logs', () => {
    const { db, sessionId } = createActiveParticipantDb({
      config: { activeMissionA: 'm01', activeMissionB: 'm02' },
    });
    db.seed('missions/m01', MISSIONS.find(m => m.id === 'm01'));
    db.seed('users/uA', {
      id: 'uA', name: 'Runner A', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
    });

    const compId = `A_${sessionId}_m01`;
    db.commitBatch([
      {
        type: 'set',
        path: `missionCompletions/${compId}`,
        data: {
          gameSessionId: sessionId,
          missionId: 'm01',
          team: 'A',
          completedBy: 'uA',
          points: 20,
          luckyReward: true,
          isFinalMission: false,
          completedAt: SERVER_TIMESTAMP_SENTINEL,
        },
        merge: false,
      },
      {
        type: 'update',
        path: 'users/uA',
        data: { score: 20, invincibleCards: 1, lastCompletionId: compId },
      },
      {
        type: 'update',
        path: 'game_config/current',
        data: {
          teamAScore: incrementSentinel(20),
          logs: [{ id: 'l1', timestamp: db.serverNowMs, message: 'Team A completed m01', type: 'MISSION' }],
        },
      },
    ], { uid: 'uA', signInProvider: 'password' });

    assert.equal(db.rawGet('users/uA').score, 20);
    assert.equal(db.rawGet('users/uA').invincibleCards, 1);
    assert.equal(db.rawGet('game_config/current').teamAScore, 20);
  });

  test('duplicate completion by same team fails rules; opposing team can still complete SAME mission', () => {
    const { db, sessionId } = createActiveParticipantDb({
      config: { activeMissionA: 'm01', activeMissionB: 'm01' },
    });
    db.seed('missions/m01', MISSIONS.find(m => m.id === 'm01'));
    db.seed('users/uA1', { id: 'uA1', name: 'A1', role: 'RUNNER', team: 'A', color: '#ef4444', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });
    db.seed('users/uA2', { id: 'uA2', name: 'A2', role: 'RUNNER', team: 'A', color: '#ef4444', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });
    db.seed('users/uB1', { id: 'uB1', name: 'B1', role: 'ONI', team: 'B', color: '#3b82f6', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });

    db.commitBatch([
      { type: 'set', path: `missionCompletions/A_${sessionId}_m01`, data: { gameSessionId: sessionId, missionId: 'm01', team: 'A', completedBy: 'uA1', points: 20, luckyReward: false, isFinalMission: false, completedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
      { type: 'update', path: 'users/uA1', data: { score: 20, invincibleCards: 0, lastCompletionId: `A_${sessionId}_m01` } },
      { type: 'update', path: 'game_config/current', data: { teamAScore: incrementSentinel(20), logs: [{ id: 'l1', timestamp: db.serverNowMs, message: 'A1', type: 'MISSION' }] } },
    ], { uid: 'uA1', signInProvider: 'password' });

    // A2 cannot complete same mission again:
    assert.throws(() => {
      db.commitBatch([
        { type: 'set', path: `missionCompletions/A_${sessionId}_m01`, data: { gameSessionId: sessionId, missionId: 'm01', team: 'A', completedBy: 'uA2', points: 20, luckyReward: false, isFinalMission: false, completedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
        { type: 'update', path: 'users/uA2', data: { score: 20, invincibleCards: 0, lastCompletionId: `A_${sessionId}_m01` } },
        { type: 'update', path: 'game_config/current', data: { teamAScore: incrementSentinel(20), logs: [{ id: 'l2', timestamp: db.serverNowMs, message: 'A2', type: 'MISSION' }, ...db.rawGet('game_config/current').logs] } },
      ], { uid: 'uA2', signInProvider: 'password' });
    }, RulePermissionError);

    // B1 CAN complete m01 for Team B:
    db.commitBatch([
      { type: 'set', path: `missionCompletions/B_${sessionId}_m01`, data: { gameSessionId: sessionId, missionId: 'm01', team: 'B', completedBy: 'uB1', points: 20, luckyReward: false, isFinalMission: false, completedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
      { type: 'update', path: 'users/uB1', data: { score: 20, invincibleCards: 0, lastCompletionId: `B_${sessionId}_m01` } },
      { type: 'update', path: 'game_config/current', data: { teamBScore: incrementSentinel(20), logs: [{ id: 'l3', timestamp: db.serverNowMs, message: 'B1', type: 'MISSION' }, ...db.rawGet('game_config/current').logs] } },
    ], { uid: 'uB1', signInProvider: 'password' });
    assert.equal(db.rawGet('game_config/current').teamBScore, 20);
  });

  for (const blockedStatus of ['WAITING', 'CAPTURED', 'EMERGENCY', 'RETIRED']) {
    test(`rejects mission completion when player status is ${blockedStatus}`, () => {
      const { db, sessionId } = createActiveParticipantDb({ config: { activeMissionA: 'm01' } });
      db.seed('missions/m01', MISSIONS.find(m => m.id === 'm01'));
      db.seed('users/uA', { id: 'uA', name: 'A', role: 'RUNNER', team: 'A', color: '#ef4444', score: 0, status: blockedStatus, gameSessionId: sessionId, invincibleCards: 0 });
      assert.throws(() => {
        db.commitBatch([
          { type: 'set', path: `missionCompletions/A_${sessionId}_m01`, data: { gameSessionId: sessionId, missionId: 'm01', team: 'A', completedBy: 'uA', points: 20, luckyReward: false, isFinalMission: false, completedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
          { type: 'update', path: 'users/uA', data: { score: 20, invincibleCards: 0, lastCompletionId: `A_${sessionId}_m01` } },
          { type: 'update', path: 'game_config/current', data: { teamAScore: incrementSentinel(20), logs: [{ id: 'l1', timestamp: db.serverNowMs, message: 'A', type: 'MISSION' }] } },
        ], { uid: 'uA', signInProvider: 'password' });
      }, RulePermissionError);
    });
  }

  for (const blockedPhase of ['PRE_GAME', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_PAUSED', 'GAME_OVER']) {
    test(`rejects normal mission completion during phase ${blockedPhase}`, () => {
      const { db, sessionId } = createActiveParticipantDb({
        config: { gameStatus: blockedPhase, activeMissionA: 'm01' },
      });
      db.seed('missions/m01', MISSIONS.find(m => m.id === 'm01'));
      db.seed('users/uA', { id: 'uA', name: 'A', role: 'RUNNER', team: 'A', color: '#ef4444', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });
      assert.throws(() => {
        db.commitBatch([
          { type: 'set', path: `missionCompletions/A_${sessionId}_m01`, data: { gameSessionId: sessionId, missionId: 'm01', team: 'A', completedBy: 'uA', points: 20, luckyReward: false, isFinalMission: false, completedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
          { type: 'update', path: 'users/uA', data: { score: 20, invincibleCards: 0, lastCompletionId: `A_${sessionId}_m01` } },
          { type: 'update', path: 'game_config/current', data: { teamAScore: incrementSentinel(20), logs: [{ id: 'l1', timestamp: db.serverNowMs, message: 'A', type: 'MISSION' }] } },
        ], { uid: 'uA', signInProvider: 'password' });
      }, RulePermissionError);
    });
  }

  test('rejects claiming unassigned mission or forged points or luckyReward without flag', () => {
    const { db, sessionId } = createActiveParticipantDb({
      config: { activeMissionA: 'm01', activeMissionB: 'm02' },
    });
    db.seed('missions/m01', MISSIONS.find(m => m.id === 'm01'));
    db.seed('missions/m02', MISSIONS.find(m => m.id === 'm02'));
    db.seed('users/uA', { id: 'uA', name: 'A', role: 'RUNNER', team: 'A', color: '#ef4444', score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0 });

    // Wrong team mission (m02 assigned to B, not A):
    assert.throws(() => {
      db.commitBatch([
        { type: 'set', path: `missionCompletions/A_${sessionId}_m02`, data: { gameSessionId: sessionId, missionId: 'm02', team: 'A', completedBy: 'uA', points: 15, luckyReward: false, isFinalMission: false, completedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
        { type: 'update', path: 'users/uA', data: { score: 15, invincibleCards: 0, lastCompletionId: `A_${sessionId}_m02` } },
        { type: 'update', path: 'game_config/current', data: { teamAScore: incrementSentinel(15), logs: [{ id: 'l1', timestamp: db.serverNowMs, message: 'cheat', type: 'MISSION' }] } },
      ], { uid: 'uA', signInProvider: 'password' });
    }, RulePermissionError);

    // Inflated points:
    assert.throws(() => {
      db.commitBatch([
        { type: 'set', path: `missionCompletions/A_${sessionId}_m01`, data: { gameSessionId: sessionId, missionId: 'm01', team: 'A', completedBy: 'uA', points: 99, luckyReward: false, isFinalMission: false, completedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
        { type: 'update', path: 'users/uA', data: { score: 99, invincibleCards: 0, lastCompletionId: `A_${sessionId}_m01` } },
        { type: 'update', path: 'game_config/current', data: { teamAScore: incrementSentinel(99), logs: [{ id: 'l1', timestamp: db.serverNowMs, message: 'cheat', type: 'MISSION' }] } },
      ], { uid: 'uA', signInProvider: 'password' });
    }, RulePermissionError);

    // Self-granting invincibleCard when luckyReward=false:
    assert.throws(() => {
      db.commitBatch([
        { type: 'set', path: `missionCompletions/A_${sessionId}_m01`, data: { gameSessionId: sessionId, missionId: 'm01', team: 'A', completedBy: 'uA', points: 20, luckyReward: false, isFinalMission: false, completedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
        { type: 'update', path: 'users/uA', data: { score: 20, invincibleCards: 1, lastCompletionId: `A_${sessionId}_m01` } },
        { type: 'update', path: 'game_config/current', data: { teamAScore: incrementSentinel(20), logs: [{ id: 'l1', timestamp: db.serverNowMs, message: 'cheat', type: 'MISSION' }] } },
      ], { uid: 'uA', signInProvider: 'password' });
    }, RulePermissionError);
  });

  test('[AUDIT-BUG] long Japanese player name (50 chars) + max mission title (120 chars) is truncated within 300-byte UTF-8 log limit', () => {
    const longName = 'あ'.repeat(50);
    const longTitle = 'い'.repeat(120);
    const rawMessage = `12:00 Team A (${longName}) が「${longTitle}」を達成！(+100pt)`;
    assert.ok(getUtf8ByteLength(rawMessage) > 300);

    const truncated = truncateToUtf8Bytes(rawMessage, 300, '...');
    assert.ok(getUtf8ByteLength(truncated) <= 300, `Expected <= 300 UTF-8 bytes, got ${getUtf8ByteLength(truncated)}`);
    assert.ok(truncated.endsWith('...'));
    assert.ok(sharedGatewaySource.includes('truncateToUtf8Bytes') && sharedGatewaySource.includes('300'));
  });

  test('valid FINAL_MISSION completion succeeds with activeFinalMissionId set and isFinalMission=true', () => {
    const { db, sessionId } = createActiveParticipantDb({
      config: {
        gameStatus: 'FINAL_MISSION',
        isFinalMissionActive: true,
        activeFinalMissionId: 'final_02',
      },
    });
    db.seed('missions/final_02', FINAL_MISSIONS[1]);
    db.seed('users/uB', {
      id: 'uB', name: 'Player B', role: 'ONI', team: 'B', color: '#3b82f6',
      score: 10, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
    });
    const compId = `B_${sessionId}_final_02`;
    db.commitBatch([
      { type: 'set', path: `missionCompletions/${compId}`, data: { gameSessionId: sessionId, missionId: 'final_02', team: 'B', completedBy: 'uB', points: 100, luckyReward: false, isFinalMission: true, completedAt: FsTimestamp.fromMillis(db.serverNowMs) }, merge: false },
      { type: 'update', path: 'users/uB', data: { score: 110, invincibleCards: 0, lastCompletionId: compId } },
      { type: 'update', path: 'game_config/current', data: { teamBScore: incrementSentinel(100), logs: [{ id: 'lf', timestamp: db.serverNowMs, message: 'Final B!', type: 'MISSION' }] } },
    ], { uid: 'uB', signInProvider: 'password' });

    assert.equal(db.rawGet('users/uB').score, 110);
    assert.equal(db.rawGet('game_config/current').teamBScore, 100);
  });

  test('verify adminOperationsGateways assignMissions actually passes catalog raw docs straight to resolveMissionAssignment', () => {
    assert.match(adminOpsSource, /resolveMissionAssignment/);
    assert.match(adminOpsSource, /FINAL_MISSIONS/);
  });
});
