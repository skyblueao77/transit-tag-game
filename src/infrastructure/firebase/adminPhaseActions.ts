import { httpsCallable } from 'firebase/functions';
import type { AdminPhaseGateway, TransitionGamePhaseFailureReason, TransitionGamePhaseInput, TransitionGamePhaseResult } from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const callable = httpsCallable<TransitionGamePhaseInput, TransitionGamePhaseResult>(functions, 'transitionGamePhase');
const reasons = new Set<TransitionGamePhaseFailureReason>(['UNAUTHENTICATED', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'CONFIG_NOT_FOUND', 'INVALID_CONFIG', 'TRANSITION_NOT_ALLOWED', 'FINAL_MISSION_NOT_FOUND', 'PERSISTENCE_ERROR']);
function mapError(error: unknown): TransitionGamePhaseFailureReason {
  const details = error && typeof error === 'object' ? (error as { details?: { reason?: unknown } }).details : undefined;
  return typeof details?.reason === 'string' && reasons.has(details.reason as TransitionGamePhaseFailureReason) ? details.reason as TransitionGamePhaseFailureReason : 'PERSISTENCE_ERROR';
}
export const firebaseAdminPhaseGateway: AdminPhaseGateway = {
  async transitionGamePhase(input) {
    try { return (await callable({ action: input.action, requestId: input.requestId })).data; }
    catch (error) { return { ok: false, reason: mapError(error) }; }
  },
};
