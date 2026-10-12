import type {
  AdjustTeamScoreInput,
  AdjustTeamScoreResult,
  AdminScoreAdjustmentGateway,
} from './gameplayPorts';

export async function adjustTeamScore(
  input: AdjustTeamScoreInput,
  gateway: AdminScoreAdjustmentGateway,
): Promise<AdjustTeamScoreResult> {
  try {
    return await gateway.adjustTeamScore(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
