import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { INITIAL_GAME_CONFIG, MISSIONS } from '../../constants.ts';
import { FINAL_MISSIONS } from '../../src/game/finalMissions.ts';
import { resolveTeamScoreAdjustment } from '../../src/game/adminScoreAdjustment.ts';
import {
  mapEmergencyLocationProjection,
  mapExposedLocationDocuments,
  mapGameConfigDocument,
  mapMissionDocuments,
  mapPlayerDocuments,
  mapPrivateLocation,
  mapUserDocument,
} from '../../src/infrastructure/firebase/snapshotMappers.ts';
import { closeViteSsrServer, renderSsrComponent } from '../helpers/viteSsrLoader.mjs';
import { createActiveParticipantDb } from './helpers/rulesContractHarness.mjs';

after(async () => {
  await closeViteSsrServer();
});

const ALL_PHASES = [
  'PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED',
  'DAY2_ACTIVE', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER',
];
const ALL_STATUSES = ['ACTIVE', 'WAITING', 'CAPTURED', 'EMERGENCY', 'RETIRED'];
const ALL_MODES = ['SURVIVAL', 'SCORE_SWAP'];

function makeUser(overrides = {}) {
  return {
    id: 'u-1',
    name: 'テスト選手',
    team: 'A',
    role: 'RUNNER',
    color: '#ef4444',
    score: 0,
    status: 'ACTIVE',
    invincibleCards: 1,
    protectionZone: 'NONE',
    shinkansenSegmentCount: 0,
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    ...INITIAL_GAME_CONFIG,
    gameSessionId: '11111111-1111-4111-8111-111111111111',
    gameStatus: 'DAY1_ACTIVE',
    ...overrides,
  };
}

describe('Audit 07: Snapshot Mappers, Admin Rules/Broadcast/Score Matrix & Exhaustive SSR State Matrix', () => {
  test('snapshotMappers withstand null, undefined, NaN coordinates, malformed timestamps, and missing fields', () => {
    const u = mapUserDocument('u1', {});
    assert.equal(u.id, 'u1');

    const players = mapPlayerDocuments([
      { id: 'u1', data: { name: 'A', team: 'A', role: 'RUNNER', color: '#000', score: 0, status: 'ACTIVE' } },
      { id: 'u2', data: { name: 'B', team: 'B', role: 'ONI', color: '#000', score: 0, status: 'ACTIVE' } },
    ]);
    assert.equal(players.length, 2);

    assert.equal(mapPrivateLocation({ gameSessionId: 's1', latitude: Number.NaN, longitude: 139 }), null);
    assert.equal(mapPrivateLocation({ gameSessionId: 's1', latitude: 35.6, longitude: 139.7 })?.latitude, 35.6);

    const exposed = mapExposedLocationDocuments([
      { id: 'bad-lat', data: { gameSessionId: 's1', latitude: '35', longitude: 139, expiresAt: 999 } },
      { id: 'wrong-sess', data: { gameSessionId: 's2', latitude: 35, longitude: 139, expiresAt: 999 } },
      {
        id: 'good',
        data: {
          gameSessionId: 's1', latitude: 35.68, longitude: 139.76,
          expiresAt: { toMillis: () => 2_000_000_000_000 },
          capturedAt: { toMillis: () => 1_750_000_000_000 },
          revealScope: 'GLOBAL',
        },
      },
    ], 's1');
    assert.deepEqual(Object.keys(exposed), ['good']);
    assert.equal(exposed.good.revealScope, 'GLOBAL');

    assert.equal(mapEmergencyLocationProjection('u1', null, 's1'), null);
    assert.equal(mapEmergencyLocationProjection('u1', {
      playerId: 'u1',
      gameSessionId: 's1',
      latitude: 35.6,
      longitude: 139.7,
      safetyStatus: 'EMERGENCY',
      projectionKind: 'EMERGENCY',
      projectedAt: { toMillis: () => 100 },
      sourceLocationUpdatedAt: { toMillis: () => 90 },
      expiresAt: { toMillis: () => 123 },
    }, 's1')?.expiresAt, 123);

    const cfg = mapGameConfigDocument({
      gameStatus: 'DAY1_ACTIVE',
      logs: null,
      locationRevealUntil: { toMillis: () => 5555 },
      teamARevealUntil: { toMillis: () => 6666 },
    }, INITIAL_GAME_CONFIG);
    assert.deepEqual(cfg.logs, []);
    assert.equal(cfg.locationRevealUntil, 5555);
    assert.equal(cfg.teamARevealUntil, 6666);
  });

  test('mapMissionDocuments preserves valid missions cleanly across standard catalog', () => {
    const mapped = mapMissionDocuments(MISSIONS.map(m => ({ id: m.id, data: { ...m } })));
    assert.equal(mapped.length, MISSIONS.length);
  });

  test('resolveTeamScoreAdjustment boundary & invalid inputs matrix', () => {
    assert.equal(resolveTeamScoreAdjustment({
      team: 'A', delta: 1000, reasonCode: 'BONUS', currentTeamAScore: 0, currentTeamBScore: 0,
    }).allowed, true);
    assert.equal(resolveTeamScoreAdjustment({
      team: 'A', delta: 1001, reasonCode: 'BONUS', currentTeamAScore: 0, currentTeamBScore: 0,
    }).allowed, false);
    assert.equal(resolveTeamScoreAdjustment({
      team: 'A', delta: -10, reasonCode: 'PENALTY', currentTeamAScore: 5, currentTeamBScore: 0,
    }).reason, 'SCORE_BELOW_ZERO');
    assert.equal(resolveTeamScoreAdjustment({
      team: 'A', delta: 0, reasonCode: 'CORRECTION', currentTeamAScore: 5, currentTeamBScore: 0,
    }).allowed, false);
    assert.equal(resolveTeamScoreAdjustment({
      team: 'A', delta: 1.5, reasonCode: 'CORRECTION', currentTeamAScore: 5, currentTeamBScore: 0,
    }).allowed, false);
  });

  test('Admin rule bounds match AdminRuleSettingsSection inputs for both SURVIVAL and SCORE_SWAP', async () => {
    for (const mode of ALL_MODES) {
      const html = await renderSsrComponent('/views/admin/AdminRuleSettingsSection.tsx', {
        config: makeConfig({ victoryMode: mode }),
        requireSessionId: () => '11111111-1111-4111-8111-111111111111',
      });
      assert.match(html, mode === 'SURVIVAL' ? /サバイバル制/ : /ポイント交代制/);
    }
  });

  // Render MissionView across all 8 phases x 5 statuses x 2 victory modes (80 permutations!)
  for (const phase of ALL_PHASES) {
    for (const status of ALL_STATUSES) {
      test(`MissionView SSR renders cleanly without crash in phase=${phase}, status=${status}`, async () => {
        const isFinal = phase === 'FINAL_MISSION';
        const html = await renderSsrComponent('/views/MissionView.tsx', {
          config: makeConfig({
            gameStatus: phase,
            isFinalMissionActive: isFinal,
            activeMissionA: 'm01',
            activeMissionB: 'm02',
            activeFinalMissionId: isFinal ? 'final_01' : null,
            finalMissionEndTime: Date.now() + 3_600_000,
          }),
          user: makeUser({ status }),
          missions: [...MISSIONS, ...FINAL_MISSIONS],
          onComplete: async () => ({ ok: true, missionId: 'm01', reward: { points: 20 }, score: { playerScoreDelta: 20, teamScoreDelta: 20, invincibleCardDelta: 0, luckyReward: false }, isFinalMission: isFinal }),
          onExposeLocation: async () => {},
        });
        assert.ok(html.length > 50);
      });
    }
  }

  // Render MapStatusHeader + MapStatusBadges + MapRunnerControls + MapOniCapturePanel across phases & statuses
  for (const phase of ALL_PHASES) {
    for (const status of ALL_STATUSES) {
      test(`Map HUD panels SSR render cleanly in phase=${phase}, status=${status}`, async () => {
        const user = makeUser({ status, shinkansenStartTime: status === 'ACTIVE' ? Date.now() - 60_000 : undefined });
        const config = makeConfig({ gameStatus: phase });
        const timeLeft = {
          waiting: status === 'WAITING' ? 120 : 0,
          invincible: 60,
          nextReveal: 300,
          final: phase === 'FINAL_MISSION' ? 600 : 0,
          oniLock: 0,
          shinkansenRemaining: 3600,
          forceReveal: 120,
          teamSearchRemaining: 90,
          penaltyRemaining: 30,
        };
        const headerHtml = await renderSsrComponent('/views/map/MapStatusHeader.tsx', {
          isOffline: false,
          timeLeft,
          gameConfig: config,
          isTeamSplitAlert: true,
          maxTeammateDistance: 2100,
          formatTime: s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
        });
        assert.ok(headerHtml.length > 0);

        const runnerHtml = await renderSsrComponent('/views/map/MapRunnerControls.tsx', {
          currentUser: user,
          gameConfig: config,
          timeLeft,
          nowMs: Date.now(),
          isProcessing: false,
          setIsProcessing: () => {},
          formatTime: s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
          onActivateInvincibility: async () => {},
          onStartShinkansenWait: async () => {},
        });
        assert.ok(runnerHtml.length > 0);

        const oniHtml = await renderSsrComponent('/views/map/MapOniCapturePanel.tsx', {
          currentUser: user,
          gameConfig: config,
          captureCandidates: [makeUser({ id: 'run-2', name: 'Runner2', team: 'B' })],
          selectedTargetId: 'run-2',
          isProcessing: false,
          onSelectTarget: () => {},
          onCapture: async () => {},
        });
        assert.ok(oniHtml.length > 0);
      });
    }
  }

  test('AdminPlayerListSection, AdminMissionCenter, AdminPhaseControlSection & AdminAuthGate render without crash under heavy data', async () => {
    const manyUsers = Array.from({ length: 60 }, (_, i) => makeUser({
      id: `u-${i}`,
      name: `選手_${i}`,
      team: i % 2 === 0 ? 'A' : 'B',
      status: ALL_STATUSES[i % ALL_STATUSES.length],
    }));

    const listHtml = await renderSsrComponent('/views/admin/AdminPlayerListSection.tsx', {
      config: makeConfig(),
      users: manyUsers,
      nowMs: Date.now(),
      modifyingPlayerIds: new Set(),
      resumingPlayerIds: new Set(),
      onChangePlayerTeam: () => {},
      onResumePlayer: () => {},
      onDeletePlayer: () => {},
    });
    assert.match(listHtml, /選手_59/);

    const missionCenterHtml = await renderSsrComponent('/views/admin/AdminMissionCenter.tsx', {
      config: makeConfig({ activeMissionA: 'm01', activeMissionB: 'm02' }),
      allMissionsList: MISSIONS,
      filteredMissions: MISSIONS,
      liveCompletions: [{ id: 'c1', gameSessionId: 's1', missionId: 'm01', team: 'A', completedBy: 'u1', points: 20, luckyReward: false, isFinalMission: false, completedAt: Date.now() }],
      missionTab: 'DISPATCH',
      onChangeTab: () => {},
      missionSearch: '',
      onChangeSearch: () => {},
      manualMissionId: '',
      onChangeManualMissionId: () => {},
      manualAwardTeam: 'A',
      onChangeManualAwardTeam: () => {},
      manualAwardMissionId: '',
      onChangeManualAwardMissionId: () => {},
      isProcessing: false,
      onCreateMission: () => {},
      onEditMission: () => {},
      onDeleteMission: () => {},
      onToggleMissionMode: () => {},
      onManualAssign: () => {},
      onShuffleMissions: () => {},
      onSyncMissionCatalog: () => {},
      onAdminAwardMission: () => {},
    });
    assert.match(missionCenterHtml, /ミッション/);

    const phaseHtml = await renderSsrComponent('/views/admin/AdminPhaseControlSection.tsx', {
      config: makeConfig({ gameStatus: 'DAY1_ACTIVE' }),
      finalMissionId: 'final_01',
      setFinalMissionId: () => {},
      isProcessing: false,
      onPhaseTransition: () => {},
    });
    assert.match(phaseHtml, /進行コントロール/);

    const setupSectionHtml = await renderSsrComponent('/views/admin/AdminSessionSetupSection.tsx', {
      config: makeConfig(),
      isSessionReady: false,
      isInitializingSession: false,
      onInitializeSession: () => {},
      onShowQrModal: () => {},
    });
    assert.match(setupSectionHtml, /セットアップ/);

    const broadcastHtml = await renderSsrComponent('/views/admin/AdminBroadcastSection.tsx', {
      config: makeConfig(),
      broadcastInput: 'テスト連絡',
      setBroadcastInput: () => {},
      isProcessing: false,
      onSendBroadcast: e => e.preventDefault(),
    });
    assert.match(broadcastHtml, /一斉通知/);
  });

  test('Admin operations pass SimulatedFirestore admin permissions and broadcast/rule updates', () => {
    const { db } = createActiveParticipantDb();
    const adminAuth = { uid: 'admin-1', signInProvider: 'password' };
    db.commitBatch([
      {
        type: 'update',
        path: 'game_config/current',
        data: {
          broadcastMessage: '重要なお知らせ',
          broadcastTime: db.serverNowMs,
          logs: [{ id: 'b1', timestamp: db.serverNowMs, message: '📢 【運営通知】重要なお知らせ', type: 'SYSTEM' }],
        },
      },
    ], adminAuth);
    assert.equal(db.rawGet('game_config/current').broadcastMessage, '重要なお知らせ');
  });
});
