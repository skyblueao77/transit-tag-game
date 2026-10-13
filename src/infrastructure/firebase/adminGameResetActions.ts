import { httpsCallable } from 'firebase/functions';
import type {
  AdminGameResetGateway,
  ExecuteGameResetInput,
  ExecuteGameResetResult,
  GameResetFailureReason,
  PrepareGameResetInput,
  PrepareGameResetPreview,
  PrepareGameResetResult,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const prepareCallable = httpsCallable<PrepareGameResetInput, unknown>(functions, 'prepareGameReset');
const executeCallable = httpsCallable<ExecuteGameResetInput, unknown>(functions, 'executeGameReset');
const failureReasons = new Set<GameResetFailureReason>([
  'UNAUTHENTICATED', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'CONFIG_NOT_FOUND', 'INVALID_CONFIG',
  'RESET_NOT_READY', 'CONFIRMATION_NOT_FOUND', 'CONFIRMATION_EXPIRED', 'CONFIRMATION_ALREADY_USED',
  'SESSION_CHANGED', 'CONFIRMATION_STALE', 'RESET_TOO_LARGE', 'REQUEST_ID_REUSED',
  'PERSISTENCE_ERROR', 'INTERNAL',
]);
const warningCodes = new Set(['SESSION_SCOPE_NOT_READY', 'RESET_TOO_LARGE']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function mapPrepareResult(value: unknown): PrepareGameResetResult {
  const keys = [
    'ok', 'confirmationToken', 'expiresAt', 'currentSessionId', 'proposedSessionId', 'sessionSchemaVersion',
    'participantCount', 'privateLocationCount', 'exposedLocationCount', 'emergencyProjectionCount',
    'estimatedWriteCount', 'resetReady', 'warningCodes',
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys) || value.ok !== true
    || typeof value.confirmationToken !== 'string' || typeof value.proposedSessionId !== 'string'
    || (value.currentSessionId !== null && typeof value.currentSessionId !== 'string')
    || !Number.isFinite(value.expiresAt) || !Number.isSafeInteger(value.sessionSchemaVersion)
    || !Number.isSafeInteger(value.participantCount) || (value.participantCount as number) < 0
    || !Number.isSafeInteger(value.privateLocationCount) || (value.privateLocationCount as number) < 0
    || !Number.isSafeInteger(value.exposedLocationCount) || (value.exposedLocationCount as number) < 0
    || !Number.isSafeInteger(value.emergencyProjectionCount) || (value.emergencyProjectionCount as number) < 0
    || !Number.isSafeInteger(value.estimatedWriteCount) || (value.estimatedWriteCount as number) < 0
    || typeof value.resetReady !== 'boolean'
    || !Array.isArray(value.warningCodes) || value.warningCodes.some(code => typeof code !== 'string' || !warningCodes.has(code))) {
    return { ok: false, reason: 'INTERNAL' };
  }
  const preview: PrepareGameResetPreview = {
    confirmationToken: value.confirmationToken,
    expiresAt: value.expiresAt as number,
    currentSessionId: value.currentSessionId as string | null,
    proposedSessionId: value.proposedSessionId,
    sessionSchemaVersion: value.sessionSchemaVersion as number,
    participantCount: value.participantCount as number,
    privateLocationCount: value.privateLocationCount as number,
    exposedLocationCount: value.exposedLocationCount as number,
    emergencyProjectionCount: value.emergencyProjectionCount as number,
    estimatedWriteCount: value.estimatedWriteCount as number,
    resetReady: value.resetReady,
    warningCodes: value.warningCodes as PrepareGameResetPreview['warningCodes'],
  };
  return { ok: true, preview };
}

function mapExecuteResult(value: unknown): ExecuteGameResetResult {
  if (!isRecord(value) || !hasExactKeys(value, ['ok', 'executed', 'newSessionId'])
    || value.ok !== true || value.executed !== true || typeof value.newSessionId !== 'string') {
    return { ok: false, reason: 'INTERNAL' };
  }
  return { ok: true, executed: true, newSessionId: value.newSessionId };
}

function failureReason(error: unknown): GameResetFailureReason {
  const details = error && typeof error === 'object'
    ? (error as { details?: { reason?: unknown } }).details
    : undefined;
  return typeof details?.reason === 'string' && failureReasons.has(details.reason as GameResetFailureReason)
    ? details.reason as GameResetFailureReason
    : 'PERSISTENCE_ERROR';
}

export const firebaseAdminGameResetGateway: AdminGameResetGateway = {
  async prepareGameReset(input) {
    try { return mapPrepareResult((await prepareCallable(input)).data); }
    catch (error) { return { ok: false, reason: failureReason(error) }; }
  },
  async executeGameReset(input) {
    try { return mapExecuteResult((await executeCallable(input)).data); }
    catch (error) { return { ok: false, reason: failureReason(error) }; }
  },
};
