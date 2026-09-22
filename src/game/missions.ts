import type { GameStatus } from './types';

export interface MissionLike {
  id: string;
  points: number;
}

export interface MissionReward {
  missionId: string;
  points: number;
  isFinalMission: boolean;
}

export function calculateMissionReward(
  mission: MissionLike,
  isFinalMission = false,
): MissionReward {
  return {
    missionId: mission.id,
    points: mission.points,
    isFinalMission,
  };
}

export function canCompleteNormalMission(status: GameStatus): boolean {
  return status === 'DAY1_ACTIVE' || status === 'DAY2_ACTIVE';
}

export function canCompleteFinalMission(status: GameStatus): boolean {
  return status === 'FINAL_MISSION';
}

export function canCompleteMission(
  status: GameStatus,
  isFinalMission: boolean,
): boolean {
  return isFinalMission
    ? canCompleteFinalMission(status)
    : canCompleteNormalMission(status);
}

/** Pure client-side duplicate check; it is not persistent enforcement. */
export function isSameMissionId(
  missionId: string,
  lastCompletedMissionId: string | null,
): boolean {
  return missionId === lastCompletedMissionId;
}
