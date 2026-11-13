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
import { auth, db } from './firebaseClient.ts';

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
} from '../../application/gameplayPorts.ts';

import {
  resolveCapture,
  type CapturePlayer,
  type CapturePlayerStatus,
} from '../../game/capture.ts';
import {
  activateInvincibility as resolveInvincibility,
} from '../../game/powerups.ts';
import {
  canCompleteMission,
  calculateMissionReward,
} from '../../game/missions.ts';
import { calculateMissionScore } from '../../game/scoring.ts';
import {
  startManualWaiting,
  resumeExpiredWaiting,
} from '../../game/waitingLifecycle.ts';
import {
  resolvePlayerSafetyAction,
  type SafetyAction,
  type SafetyReasonCode,
} from '../../game/playerSafety.ts';
import {
  resolveEmergencyLocationProjection,
} from '../../game/emergencyLocationProjection.ts';
import {
  canUsePowerup,
} from '../../game/phases.ts';
import { getPlayerRole } from '../../game/roles.ts';
import {
  isValidGameSessionId,
  sessionScopedCompletionId,
  validateExpectedSession,
  validateGameSession,
} from '../../game/gameSession.ts';
import {
  resolveAdminPhaseTransition,
} from '../../game/adminPhaseTransition.ts';
import { FINAL_MISSIONS } from '../../game/finalMissions.ts';
import {
  resolveAdminRoleSwap,
  type AdminRoleSwapPlayer,
} from '../../game/adminGameState.ts';
import {
  resolveAdminRevealSchedule,
  type AdminRevealPlayer,
} from '../../game/adminReveal.ts';
import {
  resolveTeamScoreAdjustment,
} from '../../game/adminScoreAdjustment.ts';
import {
  resolveMissionModeChange,
  resolveMissionAssignment,
} from '../../game/adminMission.ts';
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
} from '../../game/gameReset.ts';
import { DEFAULT_DYNAMIC_RULE_SETTINGS, INITIAL_GAME_CONFIG, MISSIONS } from '../../../constants.ts';
import type { Mission } from '../../../types.ts';
import type { GameStatus, Role, DynamicRuleSettings } from '../../game/types.ts';

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

async function computeResetFingerprint(fingerprintInput: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    const encoded = new TextEncoder().encode(fingerprintInput);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback FNV-1a 64-bit hex if subtle crypto is unavailable in an insecure context
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < fingerprintInput.length; i += 1) {
    const code = fingerprintInput.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
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
            ...(data.protectionZone ? { protectionZone: data.protectionZone } : {}),
          });
        }

        const captor = roster.find(p => p.id === captorId);
        const target = roster.find(p => p.id === input.targetId);
        if (!captor) return { ok: false, reason: 'PLAYER_NOT_FOUND' };
        if (!target) return { ok: false, reason: 'TARGET_NOT_FOUND' };
        if (captor.team !== 'A' && captor.team !== 'B') return { ok: false, reason: 'INVALID_CAPTOR_TEAM' };
        if (target.team !== 'A' && target.team !== 'B') return { ok: false, reason: 'INVALID_TARGET_TEAM' };

        const captureWaitMinutes =
          typeof configData.captureWaitMinutes === 'number'
          && Number.isInteger(configData.captureWaitMinutes)
          && configData.captureWaitMinutes >= 1
          && configData.captureWaitMinutes <= 120
            ? configData.captureWaitMinutes
            : undefined;

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
          startTime: configData.startTime,
          victoryMode: configData.victoryMode,
          captureWaitDurationMs: captureWaitMinutes !== undefined
            ? captureWaitMinutes * 60 * 1000
            : undefined,
        });

        if (capture.allowed === false) {
          return { ok: false, reason: 'CAPTURE_REJECTED', domainReason: capture.reason };
        }

        const isSurvival = configData.victoryMode === 'SURVIVAL';
        const logMessage = isSurvival
          ? `Team ${capture.reward.team} の鬼が逃走者を確保！(+${capture.reward.scoreDelta}pt)`
          : `Team ${capture.reward.team} が捕獲成功！攻守交代 (+${capture.reward.scoreDelta}pt)`;

        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: logMessage,
          type: 'CAPTURE',
        });

        const teamScoreField = capture.reward.team === 'A' ? 'teamAScore' : 'teamBScore';

        const configUpdates: UpdateData<DocumentData> = {
          teamARole: capture.teamRoles.teamARole,
          teamBRole: capture.teamRoles.teamBRole,
          lastCaptureTargetId: input.targetId,
          [teamScoreField]: increment(capture.reward.scoreDelta),
          logs,
        };
        if (capture.nextRevealTime !== undefined) {
          configUpdates.nextRevealTime = capture.nextRevealTime;
        }
        transaction.update(configRef, configUpdates);

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
          message: `${userData.name ?? 'Player'} が無敵カードを発動しました（30分間無敵）`,
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

        const catalogPoints = missionData.points;
        if (typeof catalogPoints !== 'number' || !Number.isInteger(catalogPoints) || catalogPoints < 1 || catalogPoints > 100) {
          return { ok: false, reason: 'PERSISTENCE_ERROR' };
        }

        const reward = calculateMissionReward({
          id: input.missionId,
          points: catalogPoints,
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
          lastCompletionId: completionId,
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

        const postShinkansenWaitMinutes =
          typeof configData.postShinkansenWaitMinutes === 'number'
          && Number.isInteger(configData.postShinkansenWaitMinutes)
          && configData.postShinkansenWaitMinutes >= 1
          && configData.postShinkansenWaitMinutes <= 180
            ? configData.postShinkansenWaitMinutes
            : undefined;
        const waitDurationMs = postShinkansenWaitMinutes !== undefined
          ? postShinkansenWaitMinutes * 60 * 1000
          : undefined;

        const result = startManualWaiting({
          status: userData.status,
          role,
          phase: configData.gameStatus,
          waitingUntil: userData.waitingUntil ?? 0,
          now,
          shinkansenWaitDurationMs: waitDurationMs,
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
      if (!input?.action || !input.reasonCode) {
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
        const exposedRef = doc(db, 'exposedLocations', uid);
        const projRef = doc(db, 'emergencyLocationProjections', uid);

        // すべての読み取りをトランザクションの最初で実行 (Firestore read-before-write 規則)
        const [userSnap, configSnap, locSnap, exposedSnap, projSnap] = await Promise.all([
          transaction.get(userRef),
          transaction.get(configRef),
          transaction.get(locRef),
          transaction.get(exposedRef),
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
          if ((decision.status === 'EMERGENCY' || decision.status === 'RETIRED') && exposedSnap.exists()) {
            transaction.delete(exposedRef);
          }
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

        const revealSchedule = resolveAdminRevealSchedule({
          scope: input.scope,
          durationMinutes: input.durationMinutes,
          roster,
          now,
        });

        if (revealSchedule.allowed === false) {
          const reason: AdminRevealFailureReason =
            revealSchedule.reason === 'ZERO_ELIGIBLE_PLAYERS'
              ? 'ZERO_VALID_LOCATIONS'
              : revealSchedule.reason === 'INVALID_ROSTER'
                ? 'INVALID_ROSTER'
                : revealSchedule.reason === 'INVALID_TIME'
                  ? 'INVALID_GAME_CONFIG'
                  : 'INVALID_ARGUMENT';
          return { ok: false, reason };
        }

        const scopeLabel = input.scope === 'GLOBAL' ? '全員' : input.scope === 'TEAM_A' ? 'Team A' : 'Team B';
        const logs = appendToConfigLogs(configData.logs, {
          id: logId,
          now,
          message: `管理者が${scopeLabel}の位置情報を${input.durationMinutes}分間強制公開しました`,
          type: 'SYSTEM',
        });

        transaction.update(configRef, {
          [revealSchedule.configField]: Timestamp.fromMillis(revealSchedule.expiresAt),
          logs,
        });

        const result: AdminRevealResult = {
          ok: true,
          scope: input.scope,
          expiresAt: revealSchedule.expiresAt,
          projectedCount: revealSchedule.targetPlayerIds.length,
          skippedCount: revealSchedule.skippedPlayerIds.length,
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

  async syncMissionCatalog(_input: SyncMissionCatalogInput): Promise<SyncMissionCatalogResult> {
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
        batch.update(doc(db, 'users', d.id), {
          ...playerResetPatch,
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

export async function sendAdminBroadcast(message: string, expectedSessionId: string): Promise<boolean> {
  try {
    const uid = requireAuthUid();
    const isAdmin = await verifyAdmin(uid);
    if (!isAdmin) return false;
    if (!isValidGameSessionId(expectedSessionId)) return false;

    const trimmed = typeof message === 'string' ? message.trim() : '';
    if (!trimmed || trimmed.length > 200) return false;

    const configRef = doc(db, 'game_config', 'current');
    await runTransaction(db, async transaction => {
      const configSnap = await transaction.get(configRef);
      if (!configSnap.exists()) {
        throw new Error('CONFIG_NOT_FOUND');
      }
      const configData = configSnap.data();
      if (configData.gameSessionId !== expectedSessionId) {
        throw new Error('SESSION_MISMATCH');
      }
      const now = Date.now();
      const logId = generateSecureId('log');
      const logs = appendToConfigLogs(configData.logs, {
        id: logId,
        now,
        message: `📢 【運営通知】${trimmed}`,
        type: 'SYSTEM',
      });
      transaction.update(configRef, {
        broadcastMessage: trimmed,
        broadcastTime: now,
        logs,
      });
    });
    return true;
  } catch (error) {
    console.error('sendAdminBroadcast error:', error);
    return false;
  }
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export async function updateAdminRuleSettings(
  settings: Partial<DynamicRuleSettings>,
  expectedSessionId: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const uid = requireAuthUid();
    const isAdmin = await verifyAdmin(uid);
    if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };
    if (!isValidGameSessionId(expectedSessionId)) return { ok: false, reason: 'INVALID_SESSION_ID' };
    if (!settings || typeof settings !== 'object') return { ok: false, reason: 'INVALID_ARGUMENT' };

    if (settings.victoryMode !== undefined && settings.victoryMode !== 'SURVIVAL' && settings.victoryMode !== 'SCORE_SWAP') {
      return { ok: false, reason: 'INVALID_VICTORY_MODE' };
    }
    if (settings.shinkansenMaxMinutes !== undefined && !isIntInRange(settings.shinkansenMaxMinutes, 0, 600)) {
      return { ok: false, reason: 'INVALID_SHINKANSEN_MAX_MINUTES' };
    }
    if (settings.shinkansenMaxSegments !== undefined && !isIntInRange(settings.shinkansenMaxSegments, 0, 50)) {
      return { ok: false, reason: 'INVALID_SHINKANSEN_MAX_SEGMENTS' };
    }
    if (settings.postShinkansenWaitMinutes !== undefined && !isIntInRange(settings.postShinkansenWaitMinutes, 1, 180)) {
      return { ok: false, reason: 'INVALID_POST_SHINKANSEN_WAIT_MINUTES' };
    }
    if (settings.periodicRevealIntervalMinutes !== undefined && !isIntInRange(settings.periodicRevealIntervalMinutes, 5, 120)) {
      return { ok: false, reason: 'INVALID_PERIODIC_REVEAL_INTERVAL_MINUTES' };
    }
    if (settings.periodicRevealDurationMinutes !== undefined && !isIntInRange(settings.periodicRevealDurationMinutes, 1, 30)) {
      return { ok: false, reason: 'INVALID_PERIODIC_REVEAL_DURATION_MINUTES' };
    }
    if (settings.captureWaitMinutes !== undefined && !isIntInRange(settings.captureWaitMinutes, 5, 120)) {
      return { ok: false, reason: 'INVALID_CAPTURE_WAIT_MINUTES' };
    }
    if (settings.missionPenaltyRevealMinutes !== undefined && !isIntInRange(settings.missionPenaltyRevealMinutes, 1, 180)) {
      return { ok: false, reason: 'INVALID_MISSION_PENALTY_REVEAL_MINUTES' };
    }

    const configRef = doc(db, 'game_config', 'current');
    return await runTransaction(db, async transaction => {
      const configSnap = await transaction.get(configRef);
      if (!configSnap.exists()) {
        return { ok: false, reason: 'CONFIG_NOT_FOUND' };
      }
      const configData = configSnap.data();
      if (configData.gameSessionId !== expectedSessionId) {
        return { ok: false, reason: 'SESSION_MISMATCH' };
      }

      const updates: UpdateData<DocumentData> = {};
      if (settings.victoryMode !== undefined) updates.victoryMode = settings.victoryMode;
      if (settings.shinkansenMaxMinutes !== undefined) updates.shinkansenMaxMinutes = settings.shinkansenMaxMinutes;
      if (settings.shinkansenMaxSegments !== undefined) updates.shinkansenMaxSegments = settings.shinkansenMaxSegments;
      if (settings.postShinkansenWaitMinutes !== undefined) updates.postShinkansenWaitMinutes = settings.postShinkansenWaitMinutes;
      if (settings.periodicRevealIntervalMinutes !== undefined) updates.periodicRevealIntervalMinutes = settings.periodicRevealIntervalMinutes;
      if (settings.periodicRevealDurationMinutes !== undefined) updates.periodicRevealDurationMinutes = settings.periodicRevealDurationMinutes;
      if (settings.captureWaitMinutes !== undefined) updates.captureWaitMinutes = settings.captureWaitMinutes;
      if (settings.missionPenaltyRevealMinutes !== undefined) updates.missionPenaltyRevealMinutes = settings.missionPenaltyRevealMinutes;

      const now = Date.now();
      const logId = generateSecureId('log');
      const modeLabel = settings.victoryMode === 'SURVIVAL' ? 'サバイバル制' : settings.victoryMode === 'SCORE_SWAP' ? 'ポイント交代制' : '';
      const detailParts: string[] = [];
      if (modeLabel) detailParts.push(`勝敗:${modeLabel}`);
      if (settings.shinkansenMaxMinutes !== undefined) detailParts.push(`新幹線上限:${settings.shinkansenMaxMinutes}分`);
      if (settings.shinkansenMaxSegments !== undefined) detailParts.push(`新幹線区間:${settings.shinkansenMaxSegments}区間`);
      if (settings.postShinkansenWaitMinutes !== undefined) detailParts.push(`下車待機:${settings.postShinkansenWaitMinutes}分`);
      if (settings.periodicRevealIntervalMinutes !== undefined) detailParts.push(`定期開示:${settings.periodicRevealIntervalMinutes}分毎`);

      const logMsg = `⚙️ 【ルール変更】管理者がルール設定を更新しました${detailParts.length > 0 ? ` (${detailParts.join(', ')})` : ''}`;
      const logs = appendToConfigLogs(configData.logs, {
        id: logId,
        now,
        message: logMsg,
        type: 'SYSTEM',
      });

      updates.logs = logs;
      updates.broadcastMessage = '【ルール変更】管理者がゲームルール設定を更新しました。';
      updates.broadcastTime = now;

      transaction.update(configRef, updates);
      return { ok: true };
    });
  } catch (error) {
    console.error('updateAdminRuleSettings error:', error);
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}

export async function applyAdminPenaltyReveal(
  targetPlayerId: string,
  durationMinutes: number,
  expectedSessionId: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const uid = requireAuthUid();
    const isAdmin = await verifyAdmin(uid);
    if (!isAdmin) return { ok: false, reason: 'PERMISSION_DENIED' };
    if (!isValidGameSessionId(expectedSessionId)) return { ok: false, reason: 'INVALID_SESSION_ID' };
    if (typeof targetPlayerId !== 'string' || targetPlayerId.trim().length === 0) {
      return { ok: false, reason: 'INVALID_PLAYER_ID' };
    }
    if (!isIntInRange(durationMinutes, 1, 180)) {
      return { ok: false, reason: 'INVALID_DURATION' };
    }

    const configRef = doc(db, 'game_config', 'current');
    const userRef = doc(db, 'users', targetPlayerId);

    return await runTransaction(db, async transaction => {
      const [configSnap, userSnap] = await Promise.all([
        transaction.get(configRef),
        transaction.get(userRef),
      ]);

      if (!configSnap.exists()) return { ok: false, reason: 'CONFIG_NOT_FOUND' };
      if (!userSnap.exists()) return { ok: false, reason: 'PLAYER_NOT_FOUND' };

      const configData = configSnap.data();
      const userData = userSnap.data();
      if (configData.gameSessionId !== expectedSessionId) {
        return { ok: false, reason: 'SESSION_MISMATCH' };
      }
      if (userData.gameSessionId !== expectedSessionId || (userData.team !== 'A' && userData.team !== 'B')) {
        return { ok: false, reason: 'PLAYER_NOT_IN_SESSION' };
      }

      const now = Date.now();
      const penaltyDurationMs = durationMinutes * 60 * 1000;
      const penaltyRevealUntil = now + penaltyDurationMs;

      // Update user document
      transaction.update(userRef, { penaltyRevealUntil });

      const logId = generateSecureId('log');
      const playerName = userData.name ?? 'Player';
      const logMsg = `🚨 【ペナルティ発動】${playerName}（Team ${userData.team ?? ''}）の位置情報が${durationMinutes}分間常時公開されました`;
      const logs = appendToConfigLogs(configData.logs, {
        id: logId,
        now,
        message: logMsg,
        type: 'SYSTEM',
      });

      transaction.update(configRef, {
        logs,
        broadcastMessage: logMsg,
        broadcastTime: now,
      });

      return { ok: true };
    });
  } catch (error) {
    console.error('applyAdminPenaltyReveal error:', error);
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}

