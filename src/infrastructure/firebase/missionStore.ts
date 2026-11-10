import {
  deleteDoc,
  doc,
  increment,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import type { Mission } from '../../../types';
import { db } from './firebaseClient';

/**
 * 管理者が新しいミッションを追加または既存のミッションを更新します。
 */
export async function createOrUpdateMission(mission: Mission): Promise<void> {
  const missionRef = doc(db, 'missions', mission.id);
  const data: Record<string, unknown> = {
    id: mission.id,
    area: mission.area || 'ALL',
    region: mission.region || 'ALL',
    title: mission.title.trim(),
    description: mission.description.trim(),
    points: Math.max(1, Math.min(100, Math.round(mission.points))),
    type: mission.type,
  };
  if (typeof mission.lat === 'number') data.lat = mission.lat;
  if (typeof mission.lng === 'number') data.lng = mission.lng;

  await setDoc(missionRef, data, { merge: true });
}

/**
 * 管理者がミッションを削除します。
 */
export async function deleteMission(missionId: string): Promise<void> {
  const missionRef = doc(db, 'missions', missionId);
  await deleteDoc(missionRef);
}

interface AwardMissionInput {
  team: 'A' | 'B';
  missionId: string;
  points: number;
  title: string;
  expectedSessionId: string;
}

/**
 * 管理者が手動でミッション達成を承認し、チームスコアを加算して記録します。
 */
export async function awardMissionCompletionByAdmin(input: AwardMissionInput): Promise<boolean> {
  const completionId = `${input.team}_${input.expectedSessionId}_${input.missionId}`;
  const completionRef = doc(db, 'missionCompletions', completionId);
  const configRef = doc(db, 'game_config', 'current');

  try {
    await runTransaction(db, async transaction => {
      const completionSnap = await transaction.get(completionRef);
      if (completionSnap.exists()) {
        throw new Error('ALREADY_COMPLETED');
      }

      const configSnap = await transaction.get(configRef);
      if (!configSnap.exists()) throw new Error('GAME_CONFIG_NOT_FOUND');
      const configData = configSnap.data();

      if (configData.gameSessionId !== input.expectedSessionId) {
        throw new Error('SESSION_CHANGED');
      }

      const scoreField = input.team === 'A' ? 'teamAScore' : 'teamBScore';
      const timeStr = new Date().toLocaleTimeString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        minute: '2-digit',
      });
      const newLog = {
        id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: Date.now(),
        message: `${timeStr} 【運営承認】Team ${input.team} が「${input.title}」を達成！(+${input.points}pt)`,
        type: 'MISSION' as const,
      };

      const existingLogs = Array.isArray(configData.logs) ? configData.logs : [];
      const updatedLogs = [newLog, ...existingLogs].slice(0, 200);

      transaction.update(configRef, {
        [scoreField]: increment(input.points),
        logs: updatedLogs,
      });

      transaction.set(completionRef, {
        gameSessionId: input.expectedSessionId,
        missionId: input.missionId,
        team: input.team,
        completedBy: 'ADMIN',
        points: input.points,
        luckyReward: false,
        isFinalMission: false,
        completedAt: serverTimestamp(),
      });
    });
    return true;
  } catch (error) {
    console.error('awardMissionCompletionByAdmin error:', error);
    return false;
  }
}
