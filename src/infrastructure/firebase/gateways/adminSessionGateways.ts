import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebaseClient.ts';

import type {
  AdminGameResetGateway,
  AdminGameStateGateway,
  AdminGameStateFailureReason,
  AdminPhaseGateway,
  ExecuteGameResetInput,
  ExecuteGameResetResult,
  InitializeGameSessionGateway,
  InitializeGameSessionInput,
  InitializeGameSessionResult,
  PrepareGameResetInput,
  PrepareGameResetResult,
  ResumePlayerInput,
  ResumePlayerResult,
  SwapTeamRolesInput,
  SwapTeamRolesResult,
  TransitionGamePhaseInput,
  TransitionGamePhaseResult,
} from '../../../application/gameplayPorts.ts';

import {
  isValidGameSessionId,
  validateExpectedSession,
  validateGameSession,
} from '../../../game/gameSession.ts';
import { resolveAdminPhaseTransition } from '../../../game/adminPhaseTransition.ts';
import { FINAL_MISSIONS } from '../../../game/finalMissions.ts';
import { resolveAdminRoleSwap, type AdminRoleSwapPlayer } from '../../../game/adminGameState.ts';
import {
  buildResetReceiptContract,
  isResetConfirmationExpired,
  isResetConfirmationStale,
  isValidResetId,
  planFutureGameResetConfig,
  planFuturePlayerReset,
  planGameResetPreview,
  resolveResetReceiptReplay,
  type ResetConfirmationSnapshot,
  type ResetDocumentIdentity,
  type ResetParticipantDocument,
  RESET_MAX_ESTIMATED_WRITES,
} from '../../../game/gameReset.ts';
import { DEFAULT_DYNAMIC_RULE_SETTINGS, INITIAL_GAME_CONFIG } from '../../../../constants.ts';
import type { GameStatus, Role } from '../../../game/types.ts';
import {
  appendToConfigLogs,
  computeResetFingerprint,
  createLogId,
  generateSecureId,
  requireAuthUid,
  verifyAdmin,
} from './shared.ts';

// ============================================================
// 6. Admin Game Session Initialization Gateway (Session初期化)
// ============================================================

export const clientGameSessionInitializationGateway: InitializeGameSessionGateway = {
  async initialize(input: InitializeGameSessionInput): Promise<InitializeGameSessionResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      const now = Date.now();
      const receiptRef = doc(db, 'admins', uid, 'sessionInitializationRequests', input.requestId);
      const receiptSnap = await getDoc(receiptRef);
      if (receiptSnap.exists()) {
        const rData = receiptSnap.data();
        return {
          ok: true,
          gameSessionId: rData.gameSessionId,
          sessionStartedAt: rData.sessionStartedAt,
          sessionSchemaVersion: rData.sessionSchemaVersion,
          duplicate: true,
          alreadyInitialized: rData.alreadyInitialized ?? false,
        };
      }

      const participantsSnap = await getDocs(query(collection(db, 'users'), where('team', 'in', ['A', 'B'])));
      const participantRefs = participantsSnap.docs.map(p => doc(db, 'users', p.id));

      return await runTransaction(db, async transaction => {
        const configRef = doc(db, 'game_config', 'current');
        const configSnap = await transaction.get(configRef);
        const configData = configSnap.exists() ? configSnap.data() : null;

        const sessionState = validateGameSession(configData);
        if (sessionState.valid) {
          const result: InitializeGameSessionResult = {
            ok: true,
            gameSessionId: sessionState.session.gameSessionId,
            sessionStartedAt: sessionState.session.sessionStartedAt,
            sessionSchemaVersion: sessionState.session.sessionSchemaVersion,
            duplicate: false,
            alreadyInitialized: true,
          };
          transaction.set(receiptRef, {
            ...result,
            requestId: input.requestId,
            createdAt: now,
          });
          return result;
        }

        const newSessionId = generateSecureId();

        const newConfig = {
          ...DEFAULT_DYNAMIC_RULE_SETTINGS,
          currentArea: typeof configData?.currentArea === 'string' ? configData.currentArea : INITIAL_GAME_CONFIG.currentArea,
          currentRegion: typeof configData?.currentRegion === 'string' ? configData.currentRegion : INITIAL_GAME_CONFIG.currentRegion,
          announcement: typeof configData?.announcement === 'string' ? configData.announcement : INITIAL_GAME_CONFIG.announcement,
          goalLat: typeof configData?.goalLat === 'number' ? configData.goalLat : INITIAL_GAME_CONFIG.goalLat,
          goalLng: typeof configData?.goalLng === 'number' ? configData.goalLng : INITIAL_GAME_CONFIG.goalLng,
          gameSessionId: newSessionId,
          sessionStartedAt: now,
          sessionSchemaVersion: 2,
          gameStatus: 'PRE_GAME' as GameStatus,
          day: 1,
          teamARole: 'RUNNER' as Role,
          teamBRole: 'ONI' as Role,
          teamAScore: 0,
          teamBScore: 0,
          missionMode: 'DIFFERENT',
          activeMissionA: null,
          activeMissionB: null,
          isGameEnded: false,
          isGameOver: false,
          isFinalMissionActive: false,
          activeFinalMissionId: null,
          startTime: 0,
          finalMissionEndTime: 0,
          nextRevealTime: now + DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealIntervalMinutes * 60 * 1000,
          lastCaptureTargetId: null,
          broadcastMessage: '',
          broadcastTime: 0,
          locationRevealUntil: null,
          teamARevealUntil: null,
          teamBRevealUntil: null,
          logs: [],
        };

        transaction.set(configRef, newConfig, { merge: true });

        for (const pRef of participantRefs) {
          transaction.update(pRef, { gameSessionId: newSessionId });
        }

        const result: InitializeGameSessionResult = {
          ok: true,
          gameSessionId: newSessionId,
          sessionStartedAt: now,
          sessionSchemaVersion: 2,
          duplicate: false,
          alreadyInitialized: false,
        };

        transaction.set(receiptRef, {
          ...result,
          requestId: input.requestId,
          createdAt: now,
        });

        return result;
      });
    } catch (error) {
      console.error('clientGameSessionInitializationGateway error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

// ============================================================
// 7. Admin Phase Gateway (フェーズ遷移)
// ============================================================

export const clientAdminPhaseGateway: AdminPhaseGateway = {
  async transitionGamePhase(input: TransitionGamePhaseInput): Promise<TransitionGamePhaseResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      const receiptRef = doc(db, 'admins', uid, 'phaseTransitionRequests', input.requestId);
      const receiptSnap = await getDoc(receiptRef);
      if (receiptSnap.exists()) {
        const rData = receiptSnap.data();
        return {
          ok: true,
          action: rData.action,
          oldPhase: rData.oldPhase,
          newPhase: rData.newPhase,
          selectedFinalMissionId: rData.selectedFinalMissionId,
          duplicate: true,
        };
      }

      const now = Date.now();
      const logId = createLogId();

      return await runTransaction(db, async transaction => {
        const configRef = doc(db, 'game_config', 'current');
        const configSnap = await transaction.get(configRef);
        if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };

        const configData = configSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        const finalMissionId = input.action === 'START_FINAL'
          ? FINAL_MISSIONS[Math.floor(Math.random() * FINAL_MISSIONS.length)]?.id
          : undefined;

        const transition = resolveAdminPhaseTransition({
          currentPhase: configData.gameStatus,
          action: input.action,
          now,
          finalMissionId,
        });

        if (transition.allowed === false) {
          if (transition.reason === 'INVALID_FINAL_MISSION') {
            return { ok: false, reason: 'FINAL_MISSION_NOT_FOUND' };
          }
          return { ok: false, reason: 'TRANSITION_NOT_ALLOWED' };
        }

        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `管理者がフェーズ「${input.action}」を実行しました (${transition.oldPhase} → ${transition.newPhase})`,
          type: 'SYSTEM',
        });

        transaction.update(configRef, {
          ...transition.updates,
          logs,
        });

        const result: TransitionGamePhaseResult = {
          ok: true,
          action: input.action,
          oldPhase: transition.oldPhase,
          newPhase: transition.newPhase,
          ...(transition.selectedFinalMissionId ? { selectedFinalMissionId: transition.selectedFinalMissionId } : {}),
          duplicate: false,
        };

        transaction.set(receiptRef, {
          ...result,
          requestId: input.requestId,
          gameSessionId: sessionValidation.gameSessionId,
          createdAt: now,
        });

        return result;
      });
    } catch (error) {
      console.error('clientAdminPhaseGateway error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

// ============================================================
// 8. Admin Game State Gateway (攻守交代・復帰)
// ============================================================

export const clientAdminGameStateGateway: AdminGameStateGateway = {
  async swapTeamRoles(input: SwapTeamRolesInput): Promise<SwapTeamRolesResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      const receiptRef = doc(db, 'admins', uid, 'roleSwapRequests', input.requestId);
      const receiptSnap = await getDoc(receiptRef);
      if (receiptSnap.exists()) {
        const rData = receiptSnap.data();
        return {
          ok: true,
          replayed: true,
          teamARole: rData.teamARole,
          teamBRole: rData.teamBRole,
          nextRevealTime: rData.nextRevealTime,
          newOniTeam: rData.newOniTeam,
        };
      }

      const participantQuery = query(
        collection(db, 'users'),
        where('gameSessionId', '==', input.expectedSessionId),
      );
      const participantsSnap = await getDocs(participantQuery);
      const participantIds = participantsSnap.docs
        .filter(d => d.data().team === 'A' || d.data().team === 'B')
        .map(d => d.id);

      const now = Date.now();
      const logId = createLogId();

      return await runTransaction(db, async transaction => {
        const configRef = doc(db, 'game_config', 'current');
        const configSnap = await transaction.get(configRef);
        if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };

        const configData = configSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        const userSnaps = await Promise.all(participantIds.map(id => transaction.get(doc(db, 'users', id))));
        const players: AdminRoleSwapPlayer[] = [];
        for (const snap of userSnaps) {
          if (!snap.exists()) continue;
          const data = snap.data();
          players.push({
            id: snap.id,
            team: data.team,
            status: data.status ?? 'ACTIVE',
          });
        }

        const roleSwap = resolveAdminRoleSwap({
          teamRoles: {
            teamARole: configData.teamARole,
            teamBRole: configData.teamBRole,
          },
          players,
          now,
        });

        if (roleSwap.allowed === false) {
          const reason: AdminGameStateFailureReason =
            roleSwap.reason === 'INVALID_ROLES' || roleSwap.reason === 'INVALID_TIME'
              ? 'INVALID_GAME_CONFIG'
              : 'INVALID_ROSTER';
          return { ok: false, reason };
        }

        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `管理者が攻守を強制交代しました (Team ${roleSwap.newOniTeam} が新ONI)`,
          type: 'SYSTEM',
        });

        transaction.update(configRef, {
          teamARole: roleSwap.teamRoles.teamARole,
          teamBRole: roleSwap.teamRoles.teamBRole,
          nextRevealTime: roleSwap.nextRevealTime,
          logs,
        });

        for (const change of roleSwap.playerChanges) {
          transaction.update(doc(db, 'users', change.playerId), {
            status: change.status,
            waitingUntil: change.waitingUntil,
            shinkansenStartTime: null,
            ...(change.invincibleUntil !== undefined ? { invincibleUntil: change.invincibleUntil } : {}),
          });
        }

        const result: SwapTeamRolesResult = {
          ok: true,
          replayed: false,
          teamARole: roleSwap.teamRoles.teamARole,
          teamBRole: roleSwap.teamRoles.teamBRole,
          nextRevealTime: roleSwap.nextRevealTime,
          newOniTeam: roleSwap.newOniTeam,
        };

        transaction.set(receiptRef, {
          ...result,
          requestId: input.requestId,
          gameSessionId: sessionValidation.gameSessionId,
          createdAt: now,
        });

        return result;
      });
    } catch (error) {
      console.error('clientAdminGameStateGateway swapTeamRoles error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },

  async resumePlayer(input: ResumePlayerInput): Promise<ResumePlayerResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      const now = Date.now();
      const logId = createLogId();

      return await runTransaction(db, async transaction => {
        const configRef = doc(db, 'game_config', 'current');
        const userRef = doc(db, 'users', input.targetId);
        const [configSnap, userSnap] = await Promise.all([
          transaction.get(configRef),
          transaction.get(userRef),
        ]);

        if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };
        if (!userSnap.exists()) return { ok: false, reason: 'PLAYER_NOT_FOUND' };

        const configData = configSnap.data();
        const userData = userSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `管理者が ${userData.name ?? input.targetId} をゲームに強制復帰させました`,
          type: 'SYSTEM',
        });

        transaction.update(userRef, {
          status: 'ACTIVE',
          waitingUntil: 0,
          shinkansenStartTime: null,
          invincibleUntil: 0,
        });
        transaction.update(configRef, { logs });

        // 緊急位置プロジェクションのクリーンアップ
        const projRef = doc(db, 'emergencyLocationProjections', input.targetId);
        transaction.delete(projRef);

        return { ok: true, resumed: true, status: 'ACTIVE' };
      });
    } catch (error) {
      console.error('clientAdminGameStateGateway resumePlayer error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

// ============================================================
// 12. Admin Game Reset Gateway (マスターリセット)
// ============================================================

export const clientAdminGameResetGateway: AdminGameResetGateway = {
  async prepareGameReset(input: PrepareGameResetInput): Promise<PrepareGameResetResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      if (!isValidGameSessionId(input.expectedSessionId)) {
        return { ok: false, reason: 'SESSION_CHANGED' };
      }

      const configSnap = await getDoc(doc(db, 'game_config', 'current'));
      const configData = configSnap.exists() ? configSnap.data() : null;
      if (!configData) return { ok: false, reason: 'CONFIG_NOT_FOUND' };
      const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
      if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

      const [usersSnap, locsSnap, exposedSnap, projSnap] = await Promise.all([
        getDocs(query(collection(db, 'users'), where('team', 'in', ['A', 'B']))),
        getDocs(collection(db, 'privateLocations')),
        getDocs(collection(db, 'exposedLocations')),
        getDocs(collection(db, 'emergencyLocationProjections')),
      ]);

      const participants: ResetParticipantDocument[] = usersSnap.docs.map(d => ({ id: d.id, team: d.data().team }));
      const privateLocations: ResetDocumentIdentity[] = locsSnap.docs.map(d => ({ id: d.id }));
      const exposedLocations: ResetDocumentIdentity[] = exposedSnap.docs.map(d => ({ id: d.id }));
      const emergencyProjections: ResetDocumentIdentity[] = projSnap.docs.map(d => ({ id: d.id }));

      const previewPlan = planGameResetPreview({
        config: configData,
        participants,
        privateLocations,
        exposedLocations,
        emergencyProjections,
      });

      if (!previewPlan) {
        return { ok: false, reason: 'INVALID_CONFIG' };
      }

      const confirmationToken = generateSecureId();
      const expiresAt = Date.now() + 5 * 60 * 1000;
      const proposedSessionId = generateSecureId();
      const fingerprint = await computeResetFingerprint(previewPlan.fingerprintInput);

      const previewData = {
        confirmationToken,
        expiresAt,
        currentSessionId: previewPlan.currentSessionId,
        proposedSessionId,
        sessionSchemaVersion: previewPlan.sessionSchemaVersion,
        participantCount: previewPlan.participantCount,
        privateLocationCount: previewPlan.privateLocationCount,
        exposedLocationCount: previewPlan.exposedLocationCount,
        emergencyProjectionCount: previewPlan.emergencyProjectionCount,
        estimatedWriteCount: previewPlan.estimatedWriteCount,
        resetReady: !previewPlan.tooLarge,
        warningCodes: previewPlan.warningCodes,
      };

      await setDoc(doc(db, 'admins', uid, 'gameResetConfirmations', confirmationToken), {
        ...previewData,
        fingerprint,
        used: false,
        createdAt: Date.now(),
      });

      return {
        ok: true,
        preview: previewData,
      };
    } catch (error) {
      console.error('clientAdminGameResetGateway prepareGameReset error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },

  async executeGameReset(input: ExecuteGameResetInput): Promise<ExecuteGameResetResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      if (!isValidResetId(input.confirmationToken) || !isValidResetId(input.requestId)) {
        return { ok: false, reason: 'INVALID_ARGUMENT' };
      }
      if (!isValidGameSessionId(input.expectedSessionId)) {
        return { ok: false, reason: 'SESSION_CHANGED' };
      }

      const receiptRef = doc(db, 'admins', uid, 'resetReceipts', input.requestId);
      const receiptSnap = await getDoc(receiptRef);
      if (receiptSnap.exists()) {
        const receiptData = receiptSnap.data();
        const replay = resolveResetReceiptReplay(
          receiptData,
          input.requestId,
          input.expectedSessionId,
          input.confirmationToken,
        );
        if (replay === 'MATCH') {
          return receiptData.result as ExecuteGameResetResult;
        }
        if (replay === 'SESSION_CHANGED') {
          return { ok: false, reason: 'SESSION_CHANGED' };
        }
        return { ok: false, reason: 'REQUEST_ID_REUSED' };
      }

      const confRef = doc(db, 'admins', uid, 'gameResetConfirmations', input.confirmationToken);
      const confSnap = await getDoc(confRef);
      if (!confSnap.exists()) return { ok: false, reason: 'CONFIRMATION_NOT_FOUND' };

      const conf = confSnap.data();
      if (conf.used === true) {
        return { ok: false, reason: 'CONFIRMATION_ALREADY_USED' };
      }
      if (conf.currentSessionId !== input.expectedSessionId) {
        return { ok: false, reason: 'SESSION_CHANGED' };
      }
      if (!conf.resetReady) {
        return { ok: false, reason: 'RESET_NOT_READY' };
      }
      if (isResetConfirmationExpired(conf.expiresAt, Date.now())) {
        return { ok: false, reason: 'CONFIRMATION_EXPIRED' };
      }

      const configRef = doc(db, 'game_config', 'current');
      const [configSnap, usersSnap, privateSnap, exposedSnap, projSnap, completionsSnap] = await Promise.all([
        getDoc(configRef),
        getDocs(query(collection(db, 'users'), where('team', 'in', ['A', 'B']))),
        getDocs(collection(db, 'privateLocations')),
        getDocs(collection(db, 'exposedLocations')),
        getDocs(collection(db, 'emergencyLocationProjections')),
        getDocs(collection(db, 'missionCompletions')),
      ]);

      if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };
      const configData = configSnap.data();
      const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
      if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

      const actualPlan = planGameResetPreview({
        config: configData,
        participants: usersSnap.docs.map(d => ({ id: d.id, team: d.data().team })),
        privateLocations: privateSnap.docs.map(d => ({ id: d.id })),
        exposedLocations: exposedSnap.docs.map(d => ({ id: d.id })),
        emergencyProjections: projSnap.docs.map(d => ({ id: d.id })),
      });
      if (!actualPlan) {
        return { ok: false, reason: 'INVALID_CONFIG' };
      }

      const actualFingerprint = await computeResetFingerprint(actualPlan.fingerprintInput);
      if (
        typeof conf.fingerprint !== 'string'
        || isResetConfirmationStale(conf as ResetConfirmationSnapshot, actualPlan, actualFingerprint)
      ) {
        return { ok: false, reason: 'CONFIRMATION_STALE' };
      }

      const now = Date.now();
      const newSessionId = conf.proposedSessionId;
      const futureConfigPlan = planFutureGameResetConfig({
        proposedSessionId: newSessionId,
        resetAt: now,
        nextRevealTime: now + DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealIntervalMinutes * 60 * 1000,
      });
      const playerResetPatch = planFuturePlayerReset(newSessionId);
      if (!futureConfigPlan || !playerResetPatch) {
        return { ok: false, reason: 'INVALID_CONFIG' };
      }

      // 1 config + N users + private + exposed + projections + conf update + receipt set
      const coreWrites = 1 + usersSnap.docs.length + privateSnap.docs.length + exposedSnap.docs.length + projSnap.docs.length + 2;
      if (coreWrites > RESET_MAX_ESTIMATED_WRITES) {
        return { ok: false, reason: 'RESET_TOO_LARGE' };
      }

      const remainingBudget = RESET_MAX_ESTIMATED_WRITES - coreWrites;
      let mainBatchCompletions = completionsSnap.docs;
      if (completionsSnap.docs.length > remainingBudget) {
        const overflowCount = completionsSnap.docs.length - remainingBudget;
        const overflowDocs = completionsSnap.docs.slice(0, overflowCount);
        mainBatchCompletions = completionsSnap.docs.slice(overflowCount);
        for (let i = 0; i < overflowDocs.length; i += 400) {
          const chunkBatch = writeBatch(db);
          for (const d of overflowDocs.slice(i, i + 400)) {
            chunkBatch.delete(doc(db, 'missionCompletions', d.id));
          }
          await chunkBatch.commit();
        }
      }

      const batch = writeBatch(db);

      const {
        clearRevealDeadlines: _clearRevealDeadlines,
        preserveLogCount: _preserveLogCount,
        ...futureConfigFields
      } = futureConfigPlan;

      // 1. game_config を初期状態にリセット（エリア情報等は維持）
      batch.set(configRef, {
        ...DEFAULT_DYNAMIC_RULE_SETTINGS,
        ...futureConfigFields,
        currentArea: typeof configData.currentArea === 'string' ? configData.currentArea : INITIAL_GAME_CONFIG.currentArea,
        currentRegion: typeof configData.currentRegion === 'string' ? configData.currentRegion : INITIAL_GAME_CONFIG.currentRegion,
        announcement: typeof configData.announcement === 'string' ? configData.announcement : INITIAL_GAME_CONFIG.announcement,
        goalLat: typeof configData.goalLat === 'number' ? configData.goalLat : INITIAL_GAME_CONFIG.goalLat,
        goalLng: typeof configData.goalLng === 'number' ? configData.goalLng : INITIAL_GAME_CONFIG.goalLng,
        lastCaptureTargetId: null,
        locationRevealUntil: null,
        teamARevealUntil: null,
        teamBRevealUntil: null,
        logs: [],
      }, { merge: true });

      // 2. プレイヤーを初期状態にリセット
      for (const d of usersSnap.docs) {
        const team = d.data().team;
        batch.update(doc(db, 'users', d.id), {
          ...playerResetPatch,
          role: team === 'B' ? 'ONI' : 'RUNNER',
          shinkansenSegmentCount: 0,
          protectionZone: 'NONE',
          penaltyRevealUntil: 0,
          lastStation: '',
          lastCompletionId: '',
        });
      }

      // 3. プライベート位置情報、公開位置スナップショット、緊急プロジェクション、ミッション履歴を削除
      for (const d of privateSnap.docs) {
        batch.delete(doc(db, 'privateLocations', d.id));
      }
      for (const d of exposedSnap.docs) {
        batch.delete(doc(db, 'exposedLocations', d.id));
      }
      for (const d of projSnap.docs) {
        batch.delete(doc(db, 'emergencyLocationProjections', d.id));
      }
      for (const d of mainBatchCompletions) {
        batch.delete(doc(db, 'missionCompletions', d.id));
      }

      // 4. 確認トークンを使用済みにし、レシートを原子的に書き込む
      batch.update(confRef, { used: true, usedAt: now });
      const receiptContract = buildResetReceiptContract(
        input.requestId,
        sessionValidation.gameSessionId,
        input.confirmationToken,
        newSessionId,
      ) ?? {
        operation: 'executeGameReset' as const,
        requestId: input.requestId,
        gameSessionId: sessionValidation.gameSessionId,
        confirmationToken: input.confirmationToken,
        result: { ok: true as const, executed: true as const, newSessionId },
      };
      batch.set(receiptRef, {
        ...receiptContract,
        createdAt: now,
      });

      await batch.commit();

      return {
        ok: true,
        executed: true,
        newSessionId,
      };
    } catch (error) {
      console.error('clientAdminGameResetGateway executeGameReset error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};
