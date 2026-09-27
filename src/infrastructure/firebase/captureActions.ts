import { httpsCallable } from 'firebase/functions';
import type {
  CaptureFailureReason,
  CaptureGateway,
  CapturePlayerInput,
  CapturePlayerResult,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const callable = httpsCallable<CapturePlayerInput, CapturePlayerResult>(
  functions,
  'capturePlayer',
);

const knownReasons = new Set<CaptureFailureReason>([
  'UNAUTHENTICATED',
  'INVALID_ARGUMENT',
  'PLAYER_NOT_FOUND',
  'TARGET_NOT_FOUND',
  'INVALID_CAPTOR_TEAM',
  'INVALID_TARGET_TEAM',
  'GAME_CONFIG_NOT_FOUND',
  'INVALID_GAME_STATE',
  'CAPTURE_REJECTED',
  'PERSISTENCE_ERROR',
]);

const knownDomainReasons = new Set([
  'PHASE',
  'CAPTOR_NOT_FOUND',
  'TARGET_NOT_FOUND',
  'SAME_PLAYER',
  'SAME_TEAM',
  'CAPTOR_ROLE',
  'TARGET_ROLE',
  'CAPTOR_STATUS',
  'TARGET_STATUS',
  'TARGET_INVINCIBLE',
]);

function failure(error: unknown): CapturePlayerResult {
  if (error && typeof error === 'object') {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === 'object') {
      const reason = (details as { reason?: unknown }).reason;
      if (typeof reason === 'string' && knownReasons.has(reason as CaptureFailureReason)) {
        const domainReason = (details as { domainReason?: unknown }).domainReason;
        return {
          ok: false,
          reason: reason as CaptureFailureReason,
          ...(typeof domainReason === 'string' && knownDomainReasons.has(domainReason)
            ? { domainReason: domainReason as Extract<CapturePlayerResult, { ok: false }>['domainReason'] }
            : {}),
        };
      }
    }
  }
  return { ok: false, reason: 'PERSISTENCE_ERROR' };
}

export const firebaseCaptureGateway: CaptureGateway = {
  async capture(input): Promise<CapturePlayerResult> {
    try {
      const response = await callable({ targetId: input.targetId });
      return response.data;
    } catch (error) {
      return failure(error);
    }
  },
};
