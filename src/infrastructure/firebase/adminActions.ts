import { httpsCallable } from 'firebase/functions';
import type {
  AdminGameStateFailureReason,
  AdminGameStateGateway,
  ResumePlayerInput,
  ResumePlayerResult,
  SwapTeamRolesInput,
  SwapTeamRolesResult,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const swapTeamRolesCallable = httpsCallable<SwapTeamRolesInput, SwapTeamRolesResult>(
  functions,
  'swapTeamRoles',
);
const resumePlayerCallable = httpsCallable<ResumePlayerInput, ResumePlayerResult>(
  functions,
  'resumePlayer',
);

const knownReasons = new Set<AdminGameStateFailureReason>([
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'INVALID_ARGUMENT',
  'PLAYER_NOT_FOUND',
  'CONFIG_NOT_FOUND',
  'INVALID_PLAYER_STATE',
  'INVALID_TEAM',
  'INVALID_GAME_CONFIG',
  'INVALID_ROSTER',
  'INVALID_STATUS',
  'ROSTER_TOO_LARGE',
  'PERSISTENCE_ERROR',
]);

function failureReason(error: unknown): AdminGameStateFailureReason {
  if (error && typeof error === 'object') {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === 'object') {
      const reason = (details as { reason?: unknown }).reason;
      if (typeof reason === 'string' && knownReasons.has(reason as AdminGameStateFailureReason)) {
        return reason as AdminGameStateFailureReason;
      }
    }
  }
  return 'PERSISTENCE_ERROR';
}

export const firebaseAdminGameStateGateway: AdminGameStateGateway = {
  async swapTeamRoles(input): Promise<SwapTeamRolesResult> {
    try {
      return (await swapTeamRolesCallable({ requestId: input.requestId })).data;
    } catch (error) {
      return { ok: false, reason: failureReason(error) };
    }
  },
  async resumePlayer(input): Promise<ResumePlayerResult> {
    try {
      return (await resumePlayerCallable({ targetId: input.targetId })).data;
    } catch (error) {
      return { ok: false, reason: failureReason(error) };
    }
  },
};
