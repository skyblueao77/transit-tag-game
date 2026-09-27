import { httpsCallable } from 'firebase/functions';
import type {
  CompleteMissionFailureReason,
  CompleteMissionInput,
  CompleteMissionResult,
  MissionCompletionGateway,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const callable = httpsCallable<CompleteMissionInput, CompleteMissionResult>(
  functions,
  'completeMission',
);

const knownReasons = new Set<CompleteMissionFailureReason>([
  'UNAUTHENTICATED',
  'INVALID_ARGUMENT',
  'PLAYER_NOT_FOUND',
  'PLAYER_NOT_ACTIVE',
  'INVALID_PLAYER_TEAM',
  'MISSION_NOT_FOUND',
  'MISSION_NOT_ACTIVE',
  'MISSION_NOT_ALLOWED',
  'ALREADY_COMPLETED',
  'PERSISTENCE_ERROR',
]);

function failureReason(error: unknown): CompleteMissionFailureReason {
  if (error && typeof error === 'object') {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === 'object') {
      const reason = (details as { reason?: unknown }).reason;
      if (typeof reason === 'string' && knownReasons.has(reason as CompleteMissionFailureReason)) {
        return reason as CompleteMissionFailureReason;
      }
    }
  }
  return 'PERSISTENCE_ERROR';
}

export const firebaseMissionCompletionGateway: MissionCompletionGateway = {
  async completeMission(input): Promise<CompleteMissionResult> {
    try {
      const response = await callable({ missionId: input.missionId });
      return response.data;
    } catch (error) {
      return { ok: false, reason: failureReason(error) };
    }
  },
};
