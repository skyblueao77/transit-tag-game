import { httpsCallable } from 'firebase/functions';
import type {
  SafetyActionFailureReason,
  SafetyActionGateway,
  SafetyActionInput,
  SafetyActionResult,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const requestSafetyActionCallable = httpsCallable<SafetyActionInput, SafetyActionResult>(
  functions,
  'requestSafetyAction',
);

const knownReasons = new Set<SafetyActionFailureReason>([
  'UNAUTHENTICATED',
  'INVALID_ARGUMENT',
  'PLAYER_NOT_FOUND',
  'CONFIG_NOT_FOUND',
  'INVALID_PLAYER_STATE',
  'INVALID_GAME_CONFIG',
  'INVALID_TEAM',
  'INVALID_ACTION',
  'INVALID_REASON_CODE',
  'REASON_ACTION_MISMATCH',
  'INVALID_STATUS',
  'RETIRED_TERMINAL',
  'PERSISTENCE_ERROR',
]);

function mapFailure(error: unknown): SafetyActionFailureReason {
  if (error && typeof error === 'object') {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === 'object') {
      const reason = (details as { reason?: unknown }).reason;
      if (typeof reason === 'string' && knownReasons.has(reason as SafetyActionFailureReason)) {
        return reason as SafetyActionFailureReason;
      }
    }
  }
  return 'PERSISTENCE_ERROR';
}

export const firebaseSafetyActionGateway: SafetyActionGateway = {
  async requestSafetyAction(input): Promise<SafetyActionResult> {
    try {
      const response = await requestSafetyActionCallable(input);
      return response.data;
    } catch (error) {
      return { ok: false, reason: mapFailure(error) };
    }
  },
};
