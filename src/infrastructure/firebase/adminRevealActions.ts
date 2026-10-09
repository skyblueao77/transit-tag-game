import { httpsCallable } from 'firebase/functions';
import type {
  AdminRevealFailureReason,
  AdminRevealGateway,
  AdminRevealInput,
  AdminRevealResult,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const revealCallable = httpsCallable<AdminRevealInput, Extract<AdminRevealResult, { ok: true }>>(
  functions,
  'revealPlayerLocations',
);

const knownReasons = new Set<AdminRevealFailureReason>([
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'INVALID_ARGUMENT',
  'CONFIG_NOT_FOUND',
  'INVALID_GAME_CONFIG',
  'INVALID_ROSTER',
  'ZERO_VALID_LOCATIONS',
  'WRITE_LIMIT_EXCEEDED',
  'PERSISTENCE_ERROR',
]);

function failureReason(error: unknown): AdminRevealFailureReason {
  if (error && typeof error === 'object') {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === 'object') {
      const reason = (details as { reason?: unknown }).reason;
      if (typeof reason === 'string' && knownReasons.has(reason as AdminRevealFailureReason)) {
        return reason as AdminRevealFailureReason;
      }
    }
  }
  return 'PERSISTENCE_ERROR';
}

export const firebaseAdminRevealGateway: AdminRevealGateway = {
  async revealPlayerLocations(input): Promise<AdminRevealResult> {
    try {
      return (await revealCallable({
        scope: input.scope,
        durationMinutes: input.durationMinutes,
        requestId: input.requestId,
      })).data;
    } catch (error) {
      return { ok: false, reason: failureReason(error) };
    }
  },
};
