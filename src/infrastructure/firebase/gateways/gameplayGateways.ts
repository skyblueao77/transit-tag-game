import {
  collection,
  doc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type DocumentData,
  type UpdateData,
} from 'firebase/firestore';
import { auth, db } from '../firebaseClient.ts';

import type {
  ActivateInvincibilityInput,
  ActivateInvincibilityResult,
  CaptureGateway,
  CapturePlayerInput,
  CapturePlayerResult,
  CompleteMissionInput,
  CompleteMissionResult,
  InvincibilityGateway,
  MissionCompletionGateway,
  ResumeWaitingInput,
  ResumeWaitingResult,
  SafetyActionGateway,
  SafetyActionInput,
  SafetyActionResult,
  StartWaitingInput,
  StartWaitingResult,
  WaitingGateway,
} from '../../../application/gameplayPorts.ts';

import {
  resolveCapture,
  type CapturePlayer,
  type CapturePlayerStatus,
} from '../../../game/capture.ts';
import { activateInvincibility as resolveInvincibility } from '../../../game/powerups.ts';
import { canCompleteMission, calculateMissionReward } from '../../../game/missions.ts';
import { calculateMissionScore } from '../../../game/scoring.ts';
import { startManualWaiting, resumeExpiredWaiting } from '../../../game/waitingLifecycle.ts';
import {
  resolvePlayerSafetyAction,
  type SafetyAction,
  type SafetyReasonCode,
} from '../../../game/playerSafety.ts';
import { resolveEmergencyLocationProjection } from '../../../game/emergencyLocationProjection.ts';
import { canUsePowerup } from '../../../game/phases.ts';
import { getPlayerRole } from '../../../game/roles.ts';
import {
  isValidGameSessionId,
  sessionScopedCompletionId,
  validateExpectedSession,
} from '../../../game/gameSession.ts';
import { appendToConfigLogs, createLogId } from './shared.ts';

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
          participantIds.map(id => transaction.get(doc(db, 'users', id))),
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
        if (!canCompleteMission(configData.gameStatus, isFinal)) {
          return { ok: false, reason: 'MISSION_NOT_ALLOWED' };
        }

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
