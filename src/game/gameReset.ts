export const RESET_SESSION_SCHEMA_VERSION = 2;
export const RESET_MAX_ESTIMATED_WRITES = 450;
export const RESET_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export type ResetWarningCode = 'SESSION_SCOPE_NOT_READY' | 'RESET_TOO_LARGE';
export type ResetGameStatus =
  | 'PRE_GAME'
  | 'DAY1_ACTIVE'
  | 'DAY1_PAUSED'
  | 'DAY1_ENDED'
  | 'DAY2_ACTIVE'
  | 'DAY2_PAUSED'
  | 'FINAL_MISSION'
  | 'GAME_OVER';

export interface ResetDocumentIdentity {
  id: string;
  revision?: string;
}

export interface ResetParticipantDocument extends ResetDocumentIdentity {
  team: unknown;
}

export interface ResetCounts {
  participantCount: number;
  privateLocationCount: number;
  exposedLocationCount: number;
  emergencyProjectionCount: number;
}

export interface ResetSessionState {
  currentSessionId: string | null;
  sessionSchemaVersion: number;
  sessionStartedAt?: number;
}

export interface ResetPreviewPlan extends ResetSessionState, ResetCounts {
  estimatedWriteCount: number;
  tooLarge: boolean;
  participantIds: string[];
  fingerprintInput: string;
  warningCodes: ResetWarningCode[];
}

export type ResetConfigValidation =
  | { allowed: true; session: ResetSessionState }
  | { allowed: false; reason: 'INVALID_CONFIG' };

export interface ResetPreviewInput {
  config: unknown;
  configRevision?: string;
  participants: readonly ResetParticipantDocument[];
  privateLocations: readonly ResetDocumentIdentity[];
  exposedLocations: readonly ResetDocumentIdentity[];
  emergencyProjections: readonly ResetDocumentIdentity[];
}

export interface ResetConfirmationSnapshot {
  currentSessionId: string | null;
  sessionSchemaVersion: number;
  participantCount: number;
  privateLocationCount: number;
  exposedLocationCount: number;
  emergencyProjectionCount: number;
  estimatedWriteCount: number;
  fingerprint: string;
}

export type ResetReceiptContract = {
  operation: 'executeGameReset';
  requestId: string;
  gameSessionId: string;
  confirmationToken: string;
  result: { ok: true; executed: true; newSessionId: string };
};

const gameStatuses = new Set<ResetGameStatus>([
  'PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED',
  'DAY2_ACTIVE', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isValidResetId(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export type ResetRequestValidation<T> =
  | { allowed: true; request: T }
  | { allowed: false; reason: 'INVALID_ARGUMENT' };

export function validatePrepareGameResetRequest(value: unknown): ResetRequestValidation<{ expectedSessionId: string }> {
  if (!isRecord(value) || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'expectedSessionId') || !isValidResetId(value.expectedSessionId)) {
    return { allowed: false, reason: 'INVALID_ARGUMENT' };
  }
  return { allowed: true, request: { expectedSessionId: value.expectedSessionId } };
}

export function validateExecuteGameResetRequest(value: unknown): ResetRequestValidation<{
  confirmationToken: string;
  requestId: string;
  expectedSessionId: string;
}> {
  if (!isRecord(value) || Object.keys(value).length !== 3
    || !Object.hasOwn(value, 'confirmationToken') || !Object.hasOwn(value, 'requestId')
    || !Object.hasOwn(value, 'expectedSessionId')
    || !isValidResetId(value.confirmationToken) || !isValidResetId(value.requestId)
    || !isValidResetId(value.expectedSessionId)) {
    return { allowed: false, reason: 'INVALID_ARGUMENT' };
  }
  return { allowed: true, request: { confirmationToken: value.confirmationToken, requestId: value.requestId, expectedSessionId: value.expectedSessionId } };
}

export function validateResetConfig(value: unknown): ResetConfigValidation {
  if (!isRecord(value)
    || !gameStatuses.has(value.gameStatus as ResetGameStatus)
    || !Number.isSafeInteger(value.teamAScore) || (value.teamAScore as number) < 0
    || !Number.isSafeInteger(value.teamBScore) || (value.teamBScore as number) < 0
    || (value.logs !== undefined && !Array.isArray(value.logs))) {
    return { allowed: false, reason: 'INVALID_CONFIG' };
  }

  const gameSessionId = value.gameSessionId;
  const sessionSchemaVersion = value.sessionSchemaVersion === undefined ? 0 : value.sessionSchemaVersion;
  const sessionStartedAt = value.sessionStartedAt;
  if (!Number.isSafeInteger(sessionSchemaVersion) || (sessionSchemaVersion as number) < 0
    || (gameSessionId !== undefined && (typeof gameSessionId !== 'string' || gameSessionId.trim().length === 0))
    || (sessionStartedAt !== undefined && (typeof sessionStartedAt !== 'number' || !Number.isFinite(sessionStartedAt) || sessionStartedAt < 0))
    || ((sessionSchemaVersion as number) === 0 && gameSessionId !== undefined)
    || ((sessionSchemaVersion as number) > 0 && typeof gameSessionId !== 'string')) {
    return { allowed: false, reason: 'INVALID_CONFIG' };
  }

  return {
    allowed: true,
    session: {
      currentSessionId: typeof gameSessionId === 'string' ? gameSessionId : null,
      sessionSchemaVersion: sessionSchemaVersion as number,
      ...(typeof sessionStartedAt === 'number' ? { sessionStartedAt } : {}),
    },
  };
}

function identityKey(document: ResetDocumentIdentity): string {
  return `${document.id}\u0000${document.revision ?? ''}`;
}

function sortedIdentityKeys(documents: readonly ResetDocumentIdentity[]): string[] {
  return documents.map(identityKey).sort();
}

export function planGameResetPreview(input: ResetPreviewInput): ResetPreviewPlan | null {
  const validation = validateResetConfig(input.config);
  if (!validation.allowed) return null;

  const participants = input.participants
    .filter(document => document.team === 'A' || document.team === 'B')
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const participantIds = participants.map(document => document.id);
  const participantIdSet = new Set(participantIds);
  const participantLocations = (documents: readonly ResetDocumentIdentity[]) => documents
    .filter(document => participantIdSet.has(document.id));
  const privateLocations = participantLocations(input.privateLocations);
  const exposedLocations = participantLocations(input.exposedLocations);
  const emergencyProjections = participantLocations(input.emergencyProjections);
  const counts: ResetCounts = {
    participantCount: participants.length,
    privateLocationCount: privateLocations.length,
    exposedLocationCount: exposedLocations.length,
    emergencyProjectionCount: emergencyProjections.length,
  };
  if (Object.values(counts).some(count => !validCount(count))) return null;

  const estimatedWriteCount = counts.participantCount + counts.privateLocationCount
    + counts.exposedLocationCount + counts.emergencyProjectionCount + 3;
  const tooLarge = estimatedWriteCount > RESET_MAX_ESTIMATED_WRITES;
  const fingerprintInput = JSON.stringify({
    configRevision: input.configRevision ?? '',
    sessionId: validation.session.currentSessionId,
    sessionSchemaVersion: validation.session.sessionSchemaVersion,
    participants: participants.map(identityKey),
    privateLocations: sortedIdentityKeys(privateLocations),
    exposedLocations: sortedIdentityKeys(exposedLocations),
    emergencyProjections: sortedIdentityKeys(emergencyProjections),
  });
  const warningCodes: ResetWarningCode[] = [];
  if (validation.session.sessionSchemaVersion < RESET_SESSION_SCHEMA_VERSION) warningCodes.push('SESSION_SCOPE_NOT_READY');
  if (tooLarge) warningCodes.push('RESET_TOO_LARGE');

  return {
    ...validation.session,
    ...counts,
    estimatedWriteCount,
    tooLarge,
    participantIds,
    fingerprintInput,
    warningCodes,
  };
}

export function isResetConfirmationExpired(expiresAt: number, now: number): boolean {
  return !Number.isFinite(expiresAt) || !Number.isFinite(now) || now >= expiresAt;
}

export function isResetConfirmationStale(
  expected: ResetConfirmationSnapshot,
  actual: ResetPreviewPlan,
  actualFingerprint: string,
): boolean {
  return expected.currentSessionId !== actual.currentSessionId
    || expected.sessionSchemaVersion !== actual.sessionSchemaVersion
    || expected.participantCount !== actual.participantCount
    || expected.privateLocationCount !== actual.privateLocationCount
    || expected.exposedLocationCount !== actual.exposedLocationCount
    || expected.emergencyProjectionCount !== actual.emergencyProjectionCount
    || expected.estimatedWriteCount !== actual.estimatedWriteCount
    || expected.fingerprint !== actualFingerprint;
}

export function isResetSessionReady(sessionSchemaVersion: number): boolean {
  return Number.isSafeInteger(sessionSchemaVersion)
    && sessionSchemaVersion >= RESET_SESSION_SCHEMA_VERSION;
}

export function buildResetReceiptContract(
  requestId: string,
  gameSessionId: string,
  confirmationToken: string,
  newSessionId: string,
): ResetReceiptContract | null {
  if (!isValidResetId(requestId) || !isValidResetId(gameSessionId)
    || !isValidResetId(confirmationToken) || !isValidResetId(newSessionId)) return null;
  return {
    operation: 'executeGameReset',
    requestId,
    gameSessionId,
    confirmationToken,
    result: { ok: true, executed: true, newSessionId },
  };
}

export type ResetReceiptReplay = 'MATCH' | 'SESSION_CHANGED' | 'REQUEST_ID_REUSED' | 'INVALID_RECEIPT';

export function resolveResetReceiptReplay(
  receipt: unknown,
  requestId: string,
  gameSessionId: string,
  confirmationToken: string,
): ResetReceiptReplay {
  if (!isRecord(receipt) || receipt.operation !== 'executeGameReset'
    || receipt.requestId !== requestId || !isRecord(receipt.result)
    || receipt.result.ok !== true || receipt.result.executed !== true
    || !isValidResetId(receipt.result.newSessionId)) return 'INVALID_RECEIPT';
  if (!isValidResetId(receipt.gameSessionId)) return 'REQUEST_ID_REUSED';
  if (receipt.gameSessionId !== gameSessionId) return 'SESSION_CHANGED';
  if (receipt.confirmationToken !== confirmationToken) return 'REQUEST_ID_REUSED';
  return 'MATCH';
}

export interface FutureGameResetConfigPatch {
  gameStatus: 'PRE_GAME';
  day: 1;
  teamAScore: 0;
  teamBScore: 0;
  missionMode: 'DIFFERENT';
  activeMissionA: null;
  activeMissionB: null;
  activeFinalMissionId: null;
  isFinalMissionActive: false;
  isGameOver: false;
  isGameEnded: false;
  startTime: 0;
  finalMissionEndTime: 0;
  teamARole: 'RUNNER';
  teamBRole: 'ONI';
  broadcastMessage: '';
  broadcastTime: 0;
  gameSessionId: string;
  sessionStartedAt: number;
  sessionSchemaVersion: number;
  nextRevealTime: number;
  clearRevealDeadlines: readonly ['locationRevealUntil', 'teamARevealUntil', 'teamBRevealUntil'];
  preserveLogCount: 199;
}

export function planFutureGameResetConfig(input: {
  proposedSessionId: string;
  resetAt: number;
  nextRevealTime: number;
}): FutureGameResetConfigPatch | null {
  if (!isValidResetId(input.proposedSessionId)
    || !Number.isFinite(input.resetAt) || input.resetAt < 0
    || !Number.isFinite(input.nextRevealTime) || input.nextRevealTime < input.resetAt) return null;
  return {
    gameStatus: 'PRE_GAME', day: 1, teamAScore: 0, teamBScore: 0,
    missionMode: 'DIFFERENT', activeMissionA: null, activeMissionB: null,
    activeFinalMissionId: null, isFinalMissionActive: false, isGameOver: false, isGameEnded: false,
    startTime: 0, finalMissionEndTime: 0, teamARole: 'RUNNER', teamBRole: 'ONI',
    broadcastMessage: '', broadcastTime: 0, gameSessionId: input.proposedSessionId,
    sessionStartedAt: input.resetAt, sessionSchemaVersion: RESET_SESSION_SCHEMA_VERSION,
    nextRevealTime: input.nextRevealTime,
    clearRevealDeadlines: ['locationRevealUntil', 'teamARevealUntil', 'teamBRevealUntil'],
    preserveLogCount: 199,
  };
}

export interface FuturePlayerResetPatch {
  gameSessionId: string;
  status: 'ACTIVE';
  score: 0;
  invincibleCards: 0;
  invincibleUntil: 0;
  waitingUntil: 0;
  shinkansenStartTime: null;
}

export function planFuturePlayerReset(gameSessionId: string): FuturePlayerResetPatch | null {
  if (!isValidResetId(gameSessionId)) return null;
  return {
    gameSessionId,
    status: 'ACTIVE', score: 0, invincibleCards: 0,
    invincibleUntil: 0, waitingUntil: 0, shinkansenStartTime: null,
  };
}
