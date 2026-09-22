export interface MissionPointsLike {
  points: number;
}

export interface MissionScoreResult {
  teamScoreDelta: number;
  playerScoreDelta: number;
  invincibleCardDelta: number;
  luckyReward: boolean;
}

export const LUCKY_REWARD_THRESHOLD = 0.2;

export function calculateMissionScore(
  mission: MissionPointsLike,
  randomValue: number,
): MissionScoreResult {
  const luckyReward = randomValue >= 0 && randomValue < LUCKY_REWARD_THRESHOLD;

  return {
    teamScoreDelta: mission.points,
    playerScoreDelta: mission.points,
    invincibleCardDelta: luckyReward ? 1 : 0,
    luckyReward,
  };
}
