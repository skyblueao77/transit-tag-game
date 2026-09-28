import { httpsCallable } from 'firebase/functions';
import type {
  ActivateInvincibilityFailureReason,
  ActivateInvincibilityInput,
  ActivateInvincibilityResult,
  InvincibilityGateway,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const callable = httpsCallable<ActivateInvincibilityInput, ActivateInvincibilityResult>(
  functions,
  'activateInvincibility',
);

const knownReasons = new Set<ActivateInvincibilityFailureReason>([
  'UNAUTHENTICATED',
  'INVALID_ARGUMENT',
  'PLAYER_NOT_FOUND',
  'CONFIG_NOT_FOUND',
  'INVALID_PLAYER_STATE',
  'INVALID_GAME_CONFIG',
  'POWERUP_NOT_ALLOWED',
  'WRONG_ROLE',
  'NO_CARDS',
  'ALREADY_ACTIVE',
  'PERSISTENCE_ERROR',
]);

function failure(error: unknown): ActivateInvincibilityResult {
  if (error && typeof error === 'object') {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === 'object') {
      const reason = (details as { reason?: unknown }).reason;
      if (typeof reason === 'string' && knownReasons.has(reason as ActivateInvincibilityFailureReason)) {
        const domainReason = (details as { domainReason?: unknown }).domainReason;
        return {
          ok: false,
          reason: reason as ActivateInvincibilityFailureReason,
          ...(domainReason === 'PHASE' ? { domainReason } : {}),
        };
      }
    }
  }
  return { ok: false, reason: 'PERSISTENCE_ERROR' };
}

export const firebaseInvincibilityGateway: InvincibilityGateway = {
  async activate(input): Promise<ActivateInvincibilityResult> {
    try {
      const response = await callable(input);
      return response.data;
    } catch (error) {
      return failure(error);
    }
  },
};
