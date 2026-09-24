import { canCompleteMission, calculateMissionReward } from '../game/missions.ts';
import { calculateMissionScore } from '../game/scoring.ts';
import type {
  CompleteMissionInput,
  CompleteMissionResult,
  MissionCompletionStore,
} from './gameplayPorts.ts';

export async function completeMission(
  input: CompleteMissionInput,
  store: MissionCompletionStore,
): Promise<CompleteMissionResult> {
  if (!canCompleteMission(input.phase, input.isFinalMission)) {
    return { ok: false, reason: 'MISSION_NOT_ALLOWED' };
  }

  const reward = calculateMissionReward(input.mission, input.isFinalMission);
  const score = calculateMissionScore(reward, input.randomValue);

  try {
    await store.applyMissionCompletion({
      playerId: input.playerId,
      team: input.team,
      teamScoreDelta: score.teamScoreDelta,
      playerScoreDelta: score.playerScoreDelta,
      invincibleCardDelta: score.invincibleCardDelta,
    });
    return { ok: true, reward, score };
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
