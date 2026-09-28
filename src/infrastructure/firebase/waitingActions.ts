import { httpsCallable } from 'firebase/functions';
import type {
  ResumeWaitingInput,
  ResumeWaitingResult,
  StartWaitingInput,
  StartWaitingResult,
  WaitingFailureReason,
  WaitingGateway,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const startWaitingCallable = httpsCallable<StartWaitingInput, StartWaitingResult>(
  functions,
  'startWaiting',
);
const resumeWaitingCallable = httpsCallable<ResumeWaitingInput, ResumeWaitingResult>(
  functions,
  'resumeWaiting',
);

const knownReasons = new Set<WaitingFailureReason>([
  'INVALID_ARGUMENT',
  'PLAYER_NOT_FOUND',
  'CONFIG_NOT_FOUND',
  'INVALID_PLAYER_STATE',
  'INVALID_GAME_CONFIG',
  'INVALID_TEAM',
  'PERSISTENCE_ERROR',
  'INVALID_STATUS',
  'INVALID_PHASE',
  'PHASE',
  'WRONG_ROLE',
  'INVALID_WAITING_STATE',
  'INVALID_SHINKANSEN_START',
  'SHINKANSEN_LIMIT_NOT_REACHED',
  'NOT_WAITING',
  'INVALID_WAITING_DEADLINE',
  'WAITING_NOT_EXPIRED',
  'INVALID_TIME',
]);

function mapFailure(error: unknown): WaitingFailureReason {
  if (error && typeof error === 'object') {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === 'object') {
      const reason = (details as { reason?: unknown }).reason;
      if (typeof reason === 'string' && knownReasons.has(reason as WaitingFailureReason)) {
        return reason as WaitingFailureReason;
      }
    }
  }
  return 'PERSISTENCE_ERROR';
}

export const firebaseWaitingGateway: WaitingGateway = {
  async startWaiting(): Promise<StartWaitingResult> {
    try {
      const response = await startWaitingCallable({});
      return response.data;
    } catch (error) {
      return { ok: false, reason: mapFailure(error) };
    }
  },
  async resumeWaiting(): Promise<ResumeWaitingResult> {
    try {
      const response = await resumeWaitingCallable({});
      return response.data;
    } catch (error) {
      return { ok: false, reason: mapFailure(error) };
    }
  },
};
