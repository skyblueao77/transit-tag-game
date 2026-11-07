import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  writeBatch,
  type DocumentData,
  type UpdateData,
} from 'firebase/firestore';
import { auth, db } from './firebaseClient';

import type {
  ActivateInvincibilityInput,
  ActivateInvincibilityResult,
  AdminGameResetGateway,
  AdminGameStateGateway,
  AdminGameStateFailureReason,
  AdminMissionGateway,
  AdminMissionFailureReason,
  AdminPhaseGateway,
  AdminRevealGateway,
  AdminRevealInput,
  AdminRevealResult,
  AdminRevealFailureReason,
  AdminScoreAdjustmentGateway,
  AdminScoreAdjustmentFailureReason,
  AdjustTeamScoreInput,
  AdjustTeamScoreResult,
  AssignMissionsInput,
  AssignMissionsResult,
  CaptureGateway,
  CapturePlayerInput,
  CapturePlayerResult,
  CompleteMissionInput,
  CompleteMissionResult,
  ExecuteGameResetInput,
  ExecuteGameResetResult,
  InitializeGameSessionGateway,
  InitializeGameSessionInput,
  InitializeGameSessionResult,
  InvincibilityGateway,
  MissionCompletionGateway,
  PrepareGameResetInput,
  PrepareGameResetResult,
  ResumePlayerInput,
  ResumePlayerResult,
  ResumeWaitingInput,
  ResumeWaitingResult,
  SafetyActionGateway,
  SafetyActionInput,
  SafetyActionResult,
  SetMissionModeInput,
  SetMissionModeResult,
  StartWaitingInput,
  StartWaitingResult,
  SwapTeamRolesInput,
  SwapTeamRolesResult,
  SyncMissionCatalogInput,
  SyncMissionCatalogResult,
  TransitionGamePhaseInput,
  TransitionGamePhaseResult,
  WaitingGateway,
} from '../../application/gameplayPorts';

import {
  resolveCapture,
  type CapturePlayer,
  type CapturePlayerStatus,
} from '../../game/capture';
import {
  activateInvincibility as resolveInvincibility,
} from '../../game/powerups';
import {
  canCompleteMission,
  calculateMissionReward,
} from '../../game/missions';
import { calculateMissionScore } from '../../game/scoring';
import {
  startManualWaiting,
  resumeExpiredWaiting,
} from '../../game/waitingLifecycle';
import {
  resolvePlayerSafetyAction,
  type SafetyAction,
  type SafetyReasonCode,
} from '../../game/playerSafety';
import {
  resolveEmergencyLocationProjection,
} from '../../game/emergencyLocationProjection';
import {
  canUsePowerup,
} from '../../game/phases';
import { getPlayerRole } from '../../game/roles';
import {
  isValidGameSessionId,
  sessionScopedCompletionId,
  validateExpectedSession,
  validateGameSession,
} from '../../game/gameSession';
import {
  resolveAdminPhaseTransition,
} from '../../game/adminPhaseTransition';
import { FINAL_MISSIONS } from '../../game/finalMissions';
import {
  resolveAdminRoleSwap,
  type AdminPlayerStatus,
  type AdminRoleSwapPlayer,
} from '../../game/adminGameState';
import {
  resolveAdminRevealPlan,
  type AdminRevealLocation,
  type AdminRevealPlayer,
} from '../../game/adminReveal';
import {
  resolveTeamScoreAdjustment,
} from '../../game/adminScoreAdjustment';
import {
  resolveMissionModeChange,
  resolveMissionAssignment,
} from '../../game/adminMission';
import {
  planGameResetPreview,
  isResetConfirmationExpired,
  type ResetDocumentIdentity,
  type ResetParticipantDocument,
  RESET_MAX_ESTIMATED_WRITES,
} from '../../game/gameReset';
import { MISSIONS } from '../../../constants';
import type { Mission } from '../../../types';
import type { GameStatus, Role, TeamRoles } from '../../game/types';

// ============================================================
// ユーティリティ
// ============================================================

const MAX_LOGS = 200;

interface LogEntryInput {
  id: string;
  now: number;
  message: string;
  type: string;
}

function formatLogTime(now: number): string {
  return new Date(now).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function appendToConfigLogs(configLogs: unknown, entry: LogEntryInput): unknown[] {
  const timeStr = formatLogTime(entry.now);
  const log = {
    id: entry.id,
    timestamp: entry.now,
    message: `${timeStr} ${entry.message}`,
    type: entry.type,
  };
  const prevLogs = Array.isArray(configLogs) ? configLogs : [];
  return [log, ...prevLogs].slice(0, MAX_LOGS);
}

function generateSecureId(prefix = ''): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      const uuid = crypto.randomUUID();
      return prefix ? `${prefix}_${uuid}` : uuid;
    }
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return prefix ? `${prefix}_${hex}` : hex;
    }
  }
  throw new Error('Secure random generator is not available in this runtime.');
}

function createLogId(): string {
  return generateSecureId('log');
}

function requireAuthUid(): string {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('UNAUTHENTICATED');
  return uid;
}

async function verifyAdmin(uid: string): Promise<boolean> {
  const adminSnap = await getDoc(doc(db, 'admins', uid));
  return adminSnap.exists();
}

// ============================================================
// 1. Capture Gateway (捕獲)
// ============================================================

export const clientCaptureGateway: CaptureGateway = {
  async capture(input: CapturePlayerInput): Promise<CapturePlayerResult> {
    try {
      const captorId = auth.currentUser?.uid;
      if (!captorId) return { ok: false, reason: 'UNAUTHENTICATED' };
      if (!input.targetId || typeof input.targetId !== 'string') {
        return { ok: false, reason: 'INVALID_ARGUMENT' };
      }
      if (!isValidGameSessionId(input.expectedSessionId)) {
        return { ok: false, reason: 'SESSION_CHANGED' };
      }

      // 参加者一覧を事前に取得 (現在のセッションに限定)
      const participantQuery = query(
        collection(db, 'users'),
        where('gameSessionId', '==', input.expectedSessionId),
      );
      const participantsSnap = await getDocs(participantQuery);
      const participantIds = participantsSnap.docs
        .filter(d => d.data().team === 'A' || d.data().team === 'B')
        .map(d => d.id);
      if (!participantIds.includes(captorId)) {
        return { ok: false, reason: 'PLAYER_NOT_FOUND' };
      }
      if (!participantIds.includes(input.targetId)) {
        return { ok: false, reason: 'TARGET_NOT_FOUND' };
      }

      const now = Date.now();
      const logId = createLogId();

      return await runTransaction(db, async transaction => {
        const configRef = doc(db, 'game_config', 'current');
        const configSnap = await transaction.get(configRef);
        if (!configSnap.exists()) {
          return { ok: false, reason: 'GAME_CONFIG_NOT_FOUND' };
        }
        const configData = configSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) {
          return { ok: false, reason: 'SESSION_CHANGED' };
        }

        const userSnaps = await Promise.all(
          participantIds.map(id => transaction.get(doc(db, 'users', id)))
        );

        const roster: CapturePlayer[] = [];
        for (const snap of userSnaps) {
          if (!snap.exists()) continue;
          const data = snap.data();
          if (data.team !== 'A' && data.team !== 'B') continue;
          roster.push({
            id: snap.id,
            team: data.team,
            status: (data.status ?? 'ACTIVE') as CapturePlayerStatus,
            invincibleCards: typeof data.invincibleCards === 'number' ? data.invincibleCards : 0,
            ...(typeof data.invincibleUntil === 'number' ? { invincibleUntil: data.invincibleUntil } : {}),
          });
        }

        const captor = roster.find(p => p.id === captorId);
        const target = roster.find(p => p.id === input.targetId);
        if (!captor) return { ok: false, reason: 'PLAYER_NOT_FOUND' };
        if (!target) return { ok: false, reason: 'TARGET_NOT_FOUND' };
        if (captor.team !== 'A' && captor.team !== 'B') return { ok: false, reason: 'INVALID_CAPTOR_TEAM' };
        if (target.team !== 'A' && target.team !== 'B') return { ok: false, reason: 'INVALID_TARGET_TEAM' };

        const capture = resolveCapture({
          captorId,
          targetId: input.targetId,
          players: roster,
          teamRoles: {
            teamARole: configData.teamARole,
            teamBRole: configData.teamBRole,
          },
          phase: configData.gameStatus,
          now,
        });

        if (capture.allowed === false) {
          return { ok: false, reason: 'CAPTURE_REJECTED', domainReason: capture.reason };
        }

        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `Team ${capture.reward.team} が捕獲成功！攻守交代 (+${capture.reward.scoreDelta}pt)`,
          type: 'CAPTURE',
        });
        const teamScoreField = capture.reward.team === 'A' ? 'teamAScore' : 'teamBScore';

        transaction.update(configRef, {
          teamARole: capture.teamRoles.teamARole,
          teamBRole: capture.teamRoles.teamBRole,
          nextRevealTime: capture.nextRevealTime,
          [teamScoreField]: increment(capture.reward.scoreDelta),
          logs,
        });

        for (const change of capture.playerChanges) {
          const userRef = doc(db, 'users', change.playerId);
          const updates: UpdateData<DocumentData> = {
            status: change.status,
            waitingUntil: change.waitingUntil,
          };
          if (change.invincibleUntil !== undefined) {
            updates.invincibleUntil = change.invincibleUntil;
          }
          if (change.invincibleCardsDelta !== 0) {
            updates.invincibleCards = increment(change.invincibleCardsDelta);
          }
          transaction.update(userRef, updates);
        }

        return { ok: true, capture };
      });
    } catch (error) {
      console.error('clientCaptureGateway error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

// ============================================================
// 2. Invincibility Gateway (無敵カード使用)
// ============================================================

export const clientInvincibilityGateway: InvincibilityGateway = {
  async activate(input: ActivateInvincibilityInput): Promise<ActivateInvincibilityResult> {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) return { ok: false, reason: 'UNAUTHENTICATED' };
      if (!isValidGameSessionId(input.expectedSessionId)) {
        return { ok: false, reason: 'SESSION_CHANGED' };
      }

      const now = Date.now();
      const logId = createLogId();

      return await runTransaction(db, async transaction => {
        const userRef = doc(db, 'users', uid);
        const configRef = doc(db, 'game_config', 'current');
        const [userSnap, configSnap] = await Promise.all([
          transaction.get(userRef),
          transaction.get(configRef),
        ]);

        if (!userSnap.exists()) return { ok: false, reason: 'PLAYER_NOT_FOUND' };
        if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };

        const userData = userSnap.data();
        const configData = configSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        if (!canUsePowerup(configData.gameStatus)) {
          return { ok: false, reason: 'POWERUP_NOT_ALLOWED', domainReason: 'PHASE' };
        }

        const role = getPlayerRole(
          { team: userData.team },
          { teamARole: configData.teamARole, teamBRole: configData.teamBRole },
        );
        if (role !== 'RUNNER') return { ok: false, reason: 'WRONG_ROLE' };

        const cards = typeof userData.invincibleCards === 'number' ? userData.invincibleCards : 0;
        if (cards <= 0) return { ok: false, reason: 'NO_CARDS' };

        const currentUntil = typeof userData.invincibleUntil === 'number' ? userData.invincibleUntil : 0;
        if (currentUntil > now) return { ok: false, reason: 'ALREADY_ACTIVE' };

        const result = resolveInvincibility({
          role,
          invincibleCards: cards,
          invincibleUntil: currentUntil,
          phase: configData.gameStatus,
          now,
        });

        if (result.allowed === false) {
          if (result.reason === 'ROLE') return { ok: false, reason: 'WRONG_ROLE' };
          if (result.reason === 'NO_CARDS') return { ok: false, reason: 'NO_CARDS' };
          if (result.reason === 'PHASE') return { ok: false, reason: 'POWERUP_NOT_ALLOWED', domainReason: 'PHASE' };
          return { ok: false, reason: 'ALREADY_ACTIVE' };
        }

        const remainingCards = cards + result.cardDelta;
        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `${userData.name ?? 'Player'} が無敵カードを発動しました（10分間無敵）`,
          type: 'SYSTEM',
        });

        transaction.update(userRef, {
          invincibleCards: remainingCards,
          invincibleUntil: result.invincibleUntil,
        });
        transaction.update(configRef, { logs });

        return {
          ok: true,
          remainingCards,
          invincibleUntil: result.invincibleUntil,
          duration: result.duration,
        };
      });
    } catch (error) {
      console.error('clientInvincibilityGateway error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

// ============================================================
// 3. Mission Completion Gateway (ミッション達成)
// ============================================================

export const clientMissionCompletionGateway: MissionCompletionGateway = {
  async completeMission(input: CompleteMissionInput): Promise<CompleteMissionResult> {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) return { ok: false, reason: 'UNAUTHENTICATED' };
      if (!input.missionId || typeof input.missionId !== 'string') {
        return { ok: false, reason: 'INVALID_ARGUMENT' };
      }
      if (!isValidGameSessionId(input.expectedSessionId)) {
        return { ok: false, reason: 'SESSION_CHANGED' };
      }

      const now = Date.now();
      const logId = createLogId();

      return await runTransaction(db, async transaction => {
        const userRef = doc(db, 'users', uid);
        const configRef = doc(db, 'game_config', 'current');
        const missionRef = doc(db, 'missions', input.missionId);

        const [userSnap, configSnap, missionSnap] = await Promise.all([
          transaction.get(userRef),
          transaction.get(configRef),
          transaction.get(missionRef),
        ]);

        if (!userSnap.exists()) return { ok: false, reason: 'PLAYER_NOT_FOUND' };
        if (!configSnap.exists()) return { ok: false, reason: 'SESSION_CHANGED' };
        if (!missionSnap.exists()) return { ok: false, reason: 'MISSION_NOT_FOUND' };

        const userData = userSnap.data();
        const configData = configSnap.data();
        const missionData = missionSnap.data();

        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        if (userData.status !== 'ACTIVE') return { ok: false, reason: 'PLAYER_NOT_ACTIVE' };
        if (userData.team !== 'A' && userData.team !== 'B') return { ok: false, reason: 'INVALID_PLAYER_TEAM' };

        const completionId = sessionScopedCompletionId(
          sessionValidation.gameSessionId,
          userData.team,
          input.missionId,
        );
        const completionRef = doc(db, 'missionCompletions', completionId);
        const completionSnap = await transaction.get(completionRef);
        if (completionSnap.exists()) return { ok: false, reason: 'ALREADY_COMPLETED' };

        const isFinal = !!configData.isFinalMissionActive && configData.activeFinalMissionId === input.missionId;
        const isAllowed = canCompleteMission(configData.gameStatus, isFinal);
        if (!isAllowed) return { ok: false, reason: 'MISSION_NOT_ALLOWED' };

        const reward = calculateMissionReward({
          id: input.missionId,
          points: typeof missionData.points === 'number' ? missionData.points : 20,
        }, isFinal);
        const score = calculateMissionScore(reward, Math.random());

        const teamScoreField = userData.team === 'A' ? 'teamAScore' : 'teamBScore';
        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `Team ${userData.team} (${userData.name ?? 'Player'}) が「${missionData.title ?? input.missionId}」を達成！(+${score.teamScoreDelta}pt)`,
          type: 'MISSION',
        });

        transaction.set(completionRef, {
          gameSessionId: sessionValidation.gameSessionId,
          missionId: input.missionId,
          team: userData.team,
          completedBy: uid,
          points: reward.points,
          luckyReward: score.luckyReward,
          isFinalMission: isFinal,
          completedAt: serverTimestamp(),
        });

        transaction.update(userRef, {
          score: (typeof userData.score === 'number' ? userData.score : 0) + score.playerScoreDelta,
          invincibleCards: (typeof userData.invincibleCards === 'number' ? userData.invincibleCards : 0) + score.invincibleCardDelta,
        });

        transaction.update(configRef, {
          [teamScoreField]: increment(score.teamScoreDelta),
          logs,
        });

        return {
          ok: true,
          missionId: input.missionId,
          reward,
          score,
          isFinalMission: isFinal,
        };
      });
    } catch (error) {
      console.error('clientMissionCompletionGateway error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

// ============================================================
// 4. Waiting Gateway (待機モード開始・復帰)
// ============================================================

export const clientWaitingGateway: WaitingGateway = {
  async startWaiting(input: StartWaitingInput): Promise<StartWaitingResult> {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) return { ok: false, reason: 'INVALID_ARGUMENT' };
      if (!isValidGameSessionId(input.expectedSessionId)) return { ok: false, reason: 'SESSION_CHANGED' };

      const now = Date.now();
      const logId = createLogId();

      return await runTransaction(db, async transaction => {
        const userRef = doc(db, 'users', uid);
        const configRef = doc(db, 'game_config', 'current');
        const [userSnap, configSnap] = await Promise.all([
          transaction.get(userRef),
          transaction.get(configRef),
        ]);

        if (!userSnap.exists()) return { ok: false, reason: 'PLAYER_NOT_FOUND' };
        if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };

        const userData = userSnap.data();
        const configData = configSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        const role = getPlayerRole(
          { team: userData.team },
          { teamARole: configData.teamARole, teamBRole: configData.teamBRole },
        );
        if (role !== 'RUNNER') return { ok: false, reason: 'WRONG_ROLE' };
        if (userData.status !== 'ACTIVE') return { ok: false, reason: 'INVALID_STATUS' };

        const result = startManualWaiting({
          status: userData.status,
          role,
          phase: configData.gameStatus,
          waitingUntil: userData.waitingUntil ?? 0,
          now,
        });

        if (result.allowed === false) {
          return { ok: false, reason: result.reason };
        }

        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `${userData.name ?? 'Player'} が待機モードに入りました`,
          type: 'SYSTEM',
        });

        transaction.update(userRef, {
          status: 'WAITING',
          waitingUntil: result.waitingUntil,
          shinkansenStartTime: null,
        });
        transaction.update(configRef, { logs });

        return {
          ok: true,
          waitingUntil: result.waitingUntil,
          duration: result.duration,
        };
      });
    } catch (error) {
      console.error('clientWaitingGateway startWaiting error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },

  async resumeWaiting(input: ResumeWaitingInput): Promise<ResumeWaitingResult> {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) return { ok: false, reason: 'INVALID_ARGUMENT' };
      if (!isValidGameSessionId(input.expectedSessionId)) return { ok: false, reason: 'SESSION_CHANGED' };

      const now = Date.now();
      const logId = createLogId();

      return await runTransaction(db, async transaction => {
        const userRef = doc(db, 'users', uid);
        const configRef = doc(db, 'game_config', 'current');
        const [userSnap, configSnap] = await Promise.all([
          transaction.get(userRef),
          transaction.get(configRef),
        ]);

        if (!userSnap.exists()) return { ok: false, reason: 'PLAYER_NOT_FOUND' };
        if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };

        const userData = userSnap.data();
        const configData = configSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        if (userData.status === 'ACTIVE') {
          return { ok: true, resumed: false };
        }

        const result = resumeExpiredWaiting({
          status: userData.status,
          waitingUntil: userData.waitingUntil ?? 0,
          now,
        });

        if (result.allowed === false) {
          return { ok: false, reason: result.reason };
        }

        if (!result.changed) {
          return { ok: true, resumed: false };
        }

        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `${userData.name ?? 'Player'} がゲームに復帰しました`,
          type: 'SYSTEM',
        });

        transaction.update(userRef, {
          status: 'ACTIVE',
          waitingUntil: 0,
          shinkansenStartTime: null,
        });
        transaction.update(configRef, { logs });

        return { ok: true, resumed: true };
      });
    } catch (error) {
      console.error('clientWaitingGateway resumeWaiting error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

// ============================================================
// 5. Safety Action Gateway (SOS / リタイア)
// ============================================================

export const clientSafetyActionGateway: SafetyActionGateway = {
  async requestSafetyAction(input: SafetyActionInput): Promise<SafetyActionResult> {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) return { ok: false, reason: 'UNAUTHENTICATED' };
      if (!input || !input.action || !input.reasonCode) {
        return { ok: false, reason: 'INVALID_ARGUMENT' };
      }
      if (!isValidGameSessionId(input.expectedSessionId)) {
        return { ok: false, reason: 'SESSION_CHANGED' };
      }

      const now = Date.now();
      const logId = createLogId();

      return await runTransaction(db, async transaction => {
        const userRef = doc(db, 'users', uid);
        const configRef = doc(db, 'game_config', 'current');
        const locRef = doc(db, 'privateLocations', uid);
        const projRef = doc(db, 'emergencyLocationProjections', uid);

        // すべての読み取りをトランザクションの最初で実行 (Firestore read-before-write 規則)
        const [userSnap, configSnap, locSnap, projSnap] = await Promise.all([
          transaction.get(userRef),
          transaction.get(configRef),
          transaction.get(locRef),
          transaction.get(projRef),
        ]);

        if (!userSnap.exists()) return { ok: false, reason: 'PLAYER_NOT_FOUND' };
        if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };

        const userData = userSnap.data();
        const configData = configSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        const decision = resolvePlayerSafetyAction({
          status: userData.status,
          action: input.action as SafetyAction,
          reasonCode: input.reasonCode as SafetyReasonCode,
        });

        if (decision.allowed === false) {
          return { ok: false, reason: decision.reason };
        }

        let projectionStatus: 'CREATED' | 'REFRESHED' | 'UNAVAILABLE' | 'STALE' | 'NOT_REQUIRED' = 'NOT_REQUIRED';

        if (decision.changed) {
          const actionLabel = input.action === 'EMERGENCY' ? 'SOS発信' : 'リタイア';
          const logs = appendToConfigLogs(configData.logs, {
            id: logId,
            now,
            message: `⚠️ ${userData.name ?? 'Player'} が${actionLabel}しました`,
            type: 'EMERGENCY',
          });

          transaction.update(userRef, {
            status: decision.status,
            waitingUntil: 0,
            shinkansenStartTime: null,
            invincibleUntil: 0,
          });
          transaction.update(configRef, { logs });
        }

        // 緊急位置プロジェクションの直接更新 (Sparkプラン対応: Cloud Functions Trigger不要化)
        if (decision.status === 'EMERGENCY') {
          if (locSnap.exists()) {
            const locData = locSnap.data();
            if (locData.gameSessionId === sessionValidation.gameSessionId) {
              const sourceLocationUpdatedAt = locData.updatedAt?.toMillis
                ? locData.updatedAt.toMillis()
                : typeof locData.updatedAt === 'number'
                  ? locData.updatedAt
                  : now;
              const projDecision = resolveEmergencyLocationProjection({
                status: decision.status,
                latitude: locData.latitude,
                longitude: locData.longitude,
                sourceLocationUpdatedAt,
                now,
              });
              if (projDecision.kind === 'PROJECT') {
                const isRefreshed = projSnap.exists() && projSnap.data().gameSessionId === sessionValidation.gameSessionId;
                transaction.set(projRef, {
                  playerId: uid,
                  gameSessionId: sessionValidation.gameSessionId,
                  latitude: locData.latitude,
                  longitude: locData.longitude,
                  projectedAt: serverTimestamp(),
                  sourceLocationUpdatedAt: locData.updatedAt ?? serverTimestamp(),
                  expiresAt: Timestamp.fromMillis(projDecision.expiresAt),
                  safetyStatus: 'EMERGENCY',
                  projectionKind: 'EMERGENCY',
                });
                projectionStatus = isRefreshed ? 'REFRESHED' : 'CREATED';
              } else {
                projectionStatus = projDecision.kind === 'STALE_LOCATION' ? 'STALE' : 'UNAVAILABLE';
              }
            } else {
              projectionStatus = 'STALE';
            }
          } else {
            projectionStatus = 'UNAVAILABLE';
          }
        } else {
          // RETIRED 等で EMERGENCY でない場合は既存プロジェクションを削除
          if (projSnap.exists()) {
            transaction.delete(projRef);
          }
        }

        return {
          ok: true,
          changed: decision.changed,
          status: decision.status,
          projectionStatus,
        };
      });
    } catch (error) {
      console.error('clientSafetyActionGateway error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

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
          gameSessionId: newSessionId,
          sessionStartedAt: now,
          sessionSchemaVersion: 2,
          gameStatus: 'PRE_GAME' as GameStatus,
          day: 1,
          teamARole: 'RUNNER' as Role,
          teamBRole: 'ONI' as Role,
          teamAScore: 0,
          teamBScore: 0,
          missionMode: 'SAME',
          isGameOver: false,
          isFinalMissionActive: false,
          activeFinalMissionId: null,
          finalMissionEndTime: 0,
          locationRevealUntil: null,
          teamARevealUntil: null,
          teamBRevealUntil: null,
          logs: [],
        };

        transaction.set(configRef, newConfig, { merge: true });

        const participantsSnap = await getDocs(query(collection(db, 'users'), where('team', 'in', ['A', 'B'])));
        for (const p of participantsSnap.docs) {
          transaction.update(doc(db, 'users', p.id), { gameSessionId: newSessionId });
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
// 9. Admin Reveal Gateway (位置スナップショット公開)
// ============================================================

export const clientAdminRevealGateway: AdminRevealGateway = {
  async revealPlayerLocations(input: AdminRevealInput): Promise<AdminRevealResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      const receiptRef = doc(db, 'admins', uid, 'revealRequests', input.requestId);
      const receiptSnap = await getDoc(receiptRef);
      if (receiptSnap.exists()) {
        const rData = receiptSnap.data();
        return {
          ok: true,
          scope: rData.scope,
          expiresAt: rData.expiresAt,
          projectedCount: rData.projectedCount,
          skippedCount: rData.skippedCount,
          duplicate: true,
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
        const locSnaps = await Promise.all(participantIds.map(id => transaction.get(doc(db, 'privateLocations', id))));

        const roster: AdminRevealPlayer[] = [];
        for (const snap of userSnaps) {
          if (!snap.exists()) continue;
          const data = snap.data();
          roster.push({
            id: snap.id,
            team: data.team,
            status: data.status ?? 'ACTIVE',
          });
        }

        const locations: AdminRevealLocation[] = [];
        for (const snap of locSnaps) {
          if (!snap.exists()) continue;
          const data = snap.data();
          locations.push({
            id: snap.id,
            gameSessionId: data.gameSessionId,
            latitude: data.latitude,
            longitude: data.longitude,
            updatedAt: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : data.updatedAt,
          });
        }

        const revealPlan = resolveAdminRevealPlan({
          scope: input.scope,
          durationMinutes: input.durationMinutes,
          roster,
          locations,
          gameSessionId: sessionValidation.gameSessionId,
          now,
        });

        if (revealPlan.allowed === false) {
          const reason: AdminRevealFailureReason =
            revealPlan.reason === 'ZERO_VALID_LOCATIONS'
              ? 'ZERO_VALID_LOCATIONS'
              : revealPlan.reason === 'INVALID_ROSTER'
                ? 'INVALID_ROSTER'
                : revealPlan.reason === 'INVALID_TIME'
                  ? 'INVALID_GAME_CONFIG'
                  : 'INVALID_ARGUMENT';
          return { ok: false, reason };
        }

        if (revealPlan.snapshots.length === 0) {
          return { ok: false, reason: 'ZERO_VALID_LOCATIONS' };
        }

        const scopeLabel = input.scope === 'GLOBAL' ? '全員' : input.scope === 'TEAM_A' ? 'Team A' : 'Team B';
        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `管理者が${scopeLabel}の位置情報を${input.durationMinutes}分間強制公開しました`,
          type: 'SYSTEM',
        });

        transaction.update(configRef, {
          [revealPlan.configField]: Timestamp.fromMillis(revealPlan.expiresAt),
          logs,
        });

        for (const snap of revealPlan.snapshots) {
          transaction.set(doc(db, 'exposedLocations', snap.playerId), {
            ...snap,
            capturedAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(snap.expiresAt),
          });
        }

        const result: AdminRevealResult = {
          ok: true,
          scope: input.scope,
          expiresAt: revealPlan.expiresAt,
          projectedCount: revealPlan.snapshots.length,
          skippedCount: roster.length - revealPlan.snapshots.length,
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
      console.error('clientAdminRevealGateway error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

// ============================================================
// 10. Admin Score Adjustment Gateway (チームスコア補正)
// ============================================================

export const clientAdminScoreAdjustmentGateway: AdminScoreAdjustmentGateway = {
  async adjustTeamScore(input: AdjustTeamScoreInput): Promise<AdjustTeamScoreResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      const receiptRef = doc(db, 'admins', uid, 'scoreAdjustmentRequests', input.requestId);
      const receiptSnap = await getDoc(receiptRef);
      if (receiptSnap.exists()) {
        const rData = receiptSnap.data();
        return {
          ok: true,
          team: rData.team,
          delta: rData.delta,
          reasonCode: rData.reasonCode,
          previousScore: rData.previousScore,
          nextScore: rData.nextScore,
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

        const adjustment = resolveTeamScoreAdjustment({
          team: input.team,
          delta: input.delta,
          reasonCode: input.reasonCode,
          currentTeamAScore: configData.teamAScore ?? 0,
          currentTeamBScore: configData.teamBScore ?? 0,
        });

        if (adjustment.allowed === false) {
          const reason: AdminScoreAdjustmentFailureReason =
            adjustment.reason === 'SCORE_BELOW_ZERO'
              ? 'SCORE_BELOW_ZERO'
              : adjustment.reason === 'INVALID_CURRENT_SCORE'
                ? 'INVALID_CONFIG'
                : 'INVALID_ARGUMENT';
          return { ok: false, reason };
        }

        const sign = adjustment.delta > 0 ? `+${adjustment.delta}` : `${adjustment.delta}`;
        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `管理者が Team ${adjustment.team} のスコアを補正しました (${sign}pt, 理由: ${adjustment.reasonCode})`,
          type: 'SYSTEM',
        });

        transaction.update(configRef, {
          [adjustment.scoreField]: adjustment.nextScore,
          logs,
        });

        const result: AdjustTeamScoreResult = {
          ok: true,
          team: adjustment.team,
          delta: adjustment.delta,
          reasonCode: adjustment.reasonCode,
          previousScore: adjustment.previousScore,
          nextScore: adjustment.nextScore,
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
      console.error('clientAdminScoreAdjustmentGateway error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};

// ============================================================
// 11. Admin Mission Gateway (ミッション管理)
// ============================================================

export const clientAdminMissionGateway: AdminMissionGateway = {
  async setMissionMode(input: SetMissionModeInput): Promise<SetMissionModeResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      return await runTransaction(db, async transaction => {
        const configRef = doc(db, 'game_config', 'current');
        const configSnap = await transaction.get(configRef);
        if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };

        const configData = configSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        const decision = resolveMissionModeChange(configData.missionMode, input.mode);
        if (decision.allowed === false) return { ok: false, reason: 'INVALID_ARGUMENT' };

        transaction.update(configRef, { missionMode: decision.mode });
        return {
          ok: true,
          action: 'setMissionMode',
          mode: decision.mode,
          changed: decision.changed,
          duplicate: false,
        };
      });
    } catch (error) {
      console.error('clientAdminMissionGateway setMissionMode error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },

  async assignMissions(input: AssignMissionsInput): Promise<AssignMissionsResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      const missionsSnap = await getDocs(collection(db, 'missions'));
      const catalog = missionsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      return await runTransaction(db, async transaction => {
        const configRef = doc(db, 'game_config', 'current');
        const configSnap = await transaction.get(configRef);
        if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };

        const configData = configSnap.data();
        const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
        if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

        const decision = resolveMissionAssignment({
          phase: configData.gameStatus,
          currentMode: configData.missionMode,
          catalog: catalog as Mission[],
          strategy: input.strategy,
          target: input.target,
          missionId: input.strategy === 'MANUAL' ? input.missionId : undefined,
          randomValues: [Math.random(), Math.random()],
        });

        if (decision.allowed === false) {
          const reason: AdminMissionFailureReason =
            decision.reason === 'INVALID_PHASE'
              ? 'INVALID_PHASE'
              : decision.reason === 'ASSIGNMENT_NOT_ALLOWED'
                ? 'ASSIGNMENT_NOT_ALLOWED'
                : decision.reason === 'INVALID_MISSION'
                  ? 'INVALID_MISSION'
                  : 'INVALID_ARGUMENT';
          return { ok: false, reason };
        }

        const updates: UpdateData<DocumentData> = {};
        if (decision.activeMissionA !== undefined) updates.activeMissionA = decision.activeMissionA;
        if (decision.activeMissionB !== undefined) updates.activeMissionB = decision.activeMissionB;

        transaction.update(configRef, updates);

        return {
          ok: true,
          action: 'assignMissions',
          strategy: decision.strategy,
          target: decision.target,
          activeMissionA: decision.activeMissionA,
          activeMissionB: decision.activeMissionB,
          selectedMissionIds: decision.selectedMissionIds,
          duplicate: false,
        };
      });
    } catch (error) {
      console.error('clientAdminMissionGateway assignMissions error:', error);
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },

  async syncMissionCatalog(input: SyncMissionCatalogInput): Promise<SyncMissionCatalogResult> {
    try {
      const uid = requireAuthUid();
      const isAdmin = await verifyAdmin(uid);
      if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };

      const batch = writeBatch(db);
      for (const m of MISSIONS) {
        const mRef = doc(db, 'missions', m.id);
        batch.set(mRef, m, { merge: true });
      }
      for (const fm of FINAL_MISSIONS) {
        const fmRef = doc(db, 'missions', fm.id);
        batch.set(fmRef, fm, { merge: true });
      }
      await batch.commit();

      return {
        ok: true,
        action: 'syncMissionCatalog',
        createdCount: MISSIONS.length + FINAL_MISSIONS.length,
        updatedCount: 0,
        unchangedCount: 0,
        totalManagedCount: MISSIONS.length + FINAL_MISSIONS.length,
        duplicate: false,
      };
    } catch (error) {
      console.error('clientAdminMissionGateway syncMissionCatalog error:', error);
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

      const confirmationToken = generateSecureId('token');
      const expiresAt = Date.now() + 5 * 60 * 1000;
      const proposedSessionId = generateSecureId();

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

      if (!isValidGameSessionId(input.expectedSessionId)) {
        return { ok: false, reason: 'SESSION_CHANGED' };
      }

      const confRef = doc(db, 'admins', uid, 'gameResetConfirmations', input.confirmationToken);
      const confSnap = await getDoc(confRef);
      if (!confSnap.exists()) return { ok: false, reason: 'CONFIRMATION_NOT_FOUND' };

      const conf = confSnap.data();
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
      const configSnap = await getDoc(configRef);
      if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };
      const configData = configSnap.data();
      const sessionValidation = validateExpectedSession(configData, input.expectedSessionId);
      if (!sessionValidation.valid) return { ok: false, reason: 'SESSION_CHANGED' };

      const now = Date.now();
      const newSessionId = conf.proposedSessionId;

      const [usersSnap, privateSnap, exposedSnap, projSnap] = await Promise.all([
        getDocs(query(collection(db, 'users'), where('team', 'in', ['A', 'B']))),
        getDocs(collection(db, 'privateLocations')),
        getDocs(collection(db, 'exposedLocations')),
        getDocs(collection(db, 'emergencyLocationProjections')),
      ]);

      const totalEstimatedWrites = 1 + usersSnap.docs.length + privateSnap.docs.length + exposedSnap.docs.length + projSnap.docs.length + 1;
      if (totalEstimatedWrites > RESET_MAX_ESTIMATED_WRITES) {
        return { ok: false, reason: 'RESET_TOO_LARGE' };
      }

      const batch = writeBatch(db);

      // 1. game_config を初期状態にリセット
      batch.set(configRef, {
        gameSessionId: newSessionId,
        sessionStartedAt: now,
        sessionSchemaVersion: 2,
        gameStatus: 'PRE_GAME',
        day: 1,
        teamARole: 'RUNNER',
        teamBRole: 'ONI',
        teamAScore: 0,
        teamBScore: 0,
        missionMode: 'SAME',
        isGameOver: false,
        isFinalMissionActive: false,
        activeFinalMissionId: null,
        finalMissionEndTime: 0,
        locationRevealUntil: null,
        teamARevealUntil: null,
        teamBRevealUntil: null,
        logs: [],
      });

      // 2. プレイヤーを初期状態にリセット
      for (const d of usersSnap.docs) {
        batch.update(doc(db, 'users', d.id), {
          gameSessionId: newSessionId,
          score: 0,
          status: 'ACTIVE',
          waitingUntil: 0,
          invincibleCards: 0,
          invincibleUntil: 0,
          shinkansenStartTime: null,
        });
      }

      // 3. プライベート位置情報、公開位置スナップショット、緊急プロジェクションを削除
      for (const d of privateSnap.docs) {
        batch.delete(doc(db, 'privateLocations', d.id));
      }
      for (const d of exposedSnap.docs) {
        batch.delete(doc(db, 'exposedLocations', d.id));
      }
      for (const d of projSnap.docs) {
        batch.delete(doc(db, 'emergencyLocationProjections', d.id));
      }

      // 4. トークンを削除
      batch.delete(confRef);

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
