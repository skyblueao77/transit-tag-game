import type {
  CompleteMissionInput,
  CompleteMissionResult,
  MissionCompletionGateway,
} from './gameplayPorts.ts';

export async function completeMission(
  input: CompleteMissionInput,
  gateway: MissionCompletionGateway,
): Promise<CompleteMissionResult> {
  try {
    return await gateway.completeMission(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
