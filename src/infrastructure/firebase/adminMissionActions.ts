import { httpsCallable } from 'firebase/functions';
import type {
  AdminMissionFailureReason,
  AdminMissionGateway,
  AssignMissionsInput,
  AssignMissionsResult,
  SetMissionModeInput,
  SetMissionModeResult,
  SyncMissionCatalogInput,
  SyncMissionCatalogResult,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const setModeCallable = httpsCallable<SetMissionModeInput, SetMissionModeResult>(functions, 'setMissionMode');
const assignCallable = httpsCallable<AssignMissionsInput, AssignMissionsResult>(functions, 'assignMissions');
const syncCallable = httpsCallable<SyncMissionCatalogInput, SyncMissionCatalogResult>(functions, 'syncMissionCatalog');
const knownReasons = new Set<AdminMissionFailureReason>([
  'UNAUTHENTICATED', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'CONFIG_NOT_FOUND',
  'INVALID_CONFIG', 'INVALID_PHASE', 'ASSIGNMENT_NOT_ALLOWED', 'INVALID_MISSION', 'PERSISTENCE_ERROR',
]);

function failureReason(error: unknown): AdminMissionFailureReason {
  const details = error && typeof error === 'object'
    ? (error as { details?: { reason?: unknown } }).details
    : undefined;
  return typeof details?.reason === 'string' && knownReasons.has(details.reason as AdminMissionFailureReason)
    ? details.reason as AdminMissionFailureReason
    : 'PERSISTENCE_ERROR';
}

export const firebaseAdminMissionGateway: AdminMissionGateway = {
  async setMissionMode(input) {
    try { return (await setModeCallable(input)).data; }
    catch (error) { return { ok: false, reason: failureReason(error) }; }
  },
  async assignMissions(input) {
    try { return (await assignCallable(input)).data; }
    catch (error) { return { ok: false, reason: failureReason(error) }; }
  },
  async syncMissionCatalog(input) {
    try { return (await syncCallable(input)).data; }
    catch (error) { return { ok: false, reason: failureReason(error) }; }
  },
};
