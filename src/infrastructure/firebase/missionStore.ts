import {
  deleteDoc,
  doc,
  getDoc,
  increment,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import type { Mission } from '../../../types';
import { auth, db } from './firebaseClient';

function createSecureLogId(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      return `log_${crypto.randomUUID()}`;
    }
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return `log_${hex}`;
    }
  }
  throw new Error('Secure random generator is not available in this runtime.');
}

async function assertAdmin(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('UNAUTHENTICATED');
  const adminSnap = await getDoc(doc(db, 'admins', uid));
  if (!adminSnap.exists()) throw new Error('PERMISSION_DENIED');
}

/**
 * 管理者が新しいミッションを追加または既存のミッションを更新します。
 */
export async function createOrUpdateMission(mission: Mission): Promise<void> {
  await assertAdmin();
  if (!mission || typeof mission.id !== 'string' || mission.id.trim().length === 0) {
    throw new Error('INVALID_MISSION_ID');
  }
  const title = typeof mission.title === 'string' ? mission.title.trim() : '';
  const description = typeof mission.description === 'string' ? mission.description.trim() : '';
  if (!title || title.length > 120 || !description || description.length > 500) {
    throw new Error('INVALID_MISSION_TEXT');
  }
  if (mission.type !== 'PHOTO' && mission.type !== 'CHECKIN') {
    throw new Error('INVALID_MISSION_TYPE');
  }
  if (!Number.isFinite(mission.points)) {
    throw new Error('INVALID_MISSION_POINTS');
  }

  const missionRef = doc(db, 'missions', mission.id.trim());
  const data: Record<string, unknown> = {
    id: mission.id.trim(),
    area: mission.area || 'ALL',
    region: mission.region || 'ALL',
    title,
    description,
    points: Math.max(1, Math.min(100, Math.round(mission.points))),
    type: mission.type,
  };
  if (typeof mission.lat === 'number' && Number.isFinite(mission.lat) && mission.lat >= -90 && mission.lat <= 90) {
    data.lat = mission.lat;
  }
  if (typeof mission.lng === 'number' && Number.isFinite(mission.lng) && mission.lng >= -180 && mission.lng <= 180) {
    data.lng = mission.lng;
  }

  await setDoc(missionRef, data, { merge: true });
}

/**
 * 管理者がミッションを削除します。
 */
export async function deleteMission(missionId: string): Promise<void> {
  await assertAdmin();
  if (typeof missionId !== 'string' || missionId.trim().length === 0) {
    throw new Error('INVALID_MISSION_ID');
  }
  const missionRef = doc(db, 'missions', missionId.trim());
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
  try {
    await assertAdmin();
    if (
      (input.team !== 'A' && input.team !== 'B')
      || typeof input.missionId !== 'string' || input.missionId.trim().length === 0
      || typeof input.expectedSessionId !== 'string' || input.expectedSessionId.trim().length === 0
      || typeof input.title !== 'string' || input.title.trim().length === 0
      || !Number.isInteger(input.points) || input.points <= 0 || input.points > 100
    ) {
      return false;
    }

    const completionId = `${input.team}_${input.expectedSessionId}_${input.missionId}`;
    const completionRef = doc(db, 'missionCompletions', completionId);
    const configRef = doc(db, 'game_config', 'current');
    const logId = createSecureLogId();

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
      const now = Date.now();
      const timeStr = new Date(now).toLocaleTimeString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        minute: '2-digit',
      });
      const newLog = {
        id: logId,
        timestamp: now,
        message: `${timeStr} 【運営承認】Team ${input.team} が「${input.title.trim()}」を達成！(+${input.points}pt)`,
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
