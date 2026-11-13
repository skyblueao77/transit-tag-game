import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  Timestamp,
  where,
  writeBatch,
  type DocumentData,
  type UpdateData,
} from 'firebase/firestore';
import { db } from '../firebaseClient.ts';

import type {
  AdminMissionFailureReason,
  AdminMissionGateway,
  AdminRevealFailureReason,
  AdminRevealGateway,
  AdminRevealInput,
  AdminRevealResult,
  AdminScoreAdjustmentFailureReason,
  AdminScoreAdjustmentGateway,
  AdjustTeamScoreInput,
  AdjustTeamScoreResult,
  AssignMissionsInput,
  AssignMissionsResult,
  SetMissionModeInput,
  SetMissionModeResult,
  SyncMissionCatalogInput,
  SyncMissionCatalogResult,
} from '../../../application/gameplayPorts.ts';

import { isValidGameSessionId, validateExpectedSession } from '../../../game/gameSession.ts';
import { FINAL_MISSIONS } from '../../../game/finalMissions.ts';
import { resolveAdminRevealSchedule, type AdminRevealPlayer } from '../../../game/adminReveal.ts';
import { resolveTeamScoreAdjustment } from '../../../game/adminScoreAdjustment.ts';
import { resolveMissionModeChange, resolveMissionAssignment } from '../../../game/adminMission.ts';
import { MISSIONS } from '../../../../constants.ts';
import type { Mission } from '../../../../types.ts';
import type { DynamicRuleSettings } from '../../../game/types.ts';
import {
  appendToConfigLogs,
  createLogId,
  generateSecureId,
  isIntInRange,
  requireAuthUid,
  verifyAdmin,
} from './shared.ts';

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
