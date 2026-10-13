import { httpsCallable } from 'firebase/functions';
import type {
  InitializeGameSessionFailureReason,
  InitializeGameSessionGateway,
  InitializeGameSessionInput,
  InitializeGameSessionResult,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const callable = httpsCallable<InitializeGameSessionInput, unknown>(functions, 'initializeGameSession');
const reasons = new Set<InitializeGameSessionFailureReason>([
  'UNAUTHENTICATED', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'CONFIG_NOT_FOUND',
  'INVALID_CONFIG', 'SESSION_CHANGED', 'ROSTER_TOO_LARGE', 'PERSISTENCE_ERROR',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const firebaseGameSessionInitializationGateway: InitializeGameSessionGateway = {
  async initialize(input): Promise<InitializeGameSessionResult> {
    try {
      const result = (await callable(input)).data;
      if (isRecord(result) && result.ok === true
        && typeof result.gameSessionId === 'string'
        && Number.isSafeInteger(result.sessionStartedAt)
        && result.sessionSchemaVersion === 2
        && typeof result.duplicate === 'boolean'
        && typeof result.alreadyInitialized === 'boolean') {
        return {
          ok: true,
          gameSessionId: result.gameSessionId,
          sessionStartedAt: result.sessionStartedAt as number,
          sessionSchemaVersion: 2,
          duplicate: result.duplicate,
          alreadyInitialized: result.alreadyInitialized,
        };
      }
      return { ok: false, reason: 'PERSISTENCE_ERROR' };
    } catch (error) {
      const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
      return typeof details?.reason === 'string' && reasons.has(details.reason as InitializeGameSessionFailureReason)
        ? { ok: false, reason: details.reason as InitializeGameSessionFailureReason }
        : { ok: false, reason: 'PERSISTENCE_ERROR' };
    }
  },
};
