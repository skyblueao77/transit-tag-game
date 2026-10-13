import { createHash } from 'node:crypto';
import {
  isResetConfirmationExpired,
  isResetConfirmationStale,
  isResetSessionReady,
  isValidResetId,
  planFutureGameResetConfig,
  planFuturePlayerReset,
  planGameResetPreview,
  RESET_CONFIRMATION_TTL_MS,
  RESET_MAX_ESTIMATED_WRITES,
  validateExecuteGameResetRequest,
  validatePrepareGameResetRequest,
  validateResetConfig,
  buildResetReceiptContract,
  resolveResetReceiptReplay,
} from '../../../src/game/gameReset';
import { validateExpectedSession } from '../../../src/game/gameSession';
import type {
  ResetDocumentIdentity,
  ResetParticipantDocument,
  ResetPreviewPlan,
} from '../../../src/game/gameReset';

export type GameResetFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_CONFIG'
  | 'RESET_NOT_READY'
  | 'CONFIRMATION_NOT_FOUND'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_ALREADY_USED'
  | 'SESSION_CHANGED'
  | 'CONFIRMATION_STALE'
  | 'RESET_TOO_LARGE'
  | 'REQUEST_ID_REUSED'
  | 'PERSISTENCE_ERROR'
  | 'INTERNAL';

export class GameResetServiceError extends Error {
  constructor(readonly reason: GameResetFailureReason) {
    super(reason);
    this.name = 'GameResetServiceError';
  }
}

export type ResetCollectionName = 'privateLocations' | 'exposedLocations' | 'emergencyLocationProjections';

export interface GameResetDocument extends ResetDocumentIdentity {
  data: Record<string, unknown>;
}

export interface GameResetConfirmation {
  tokenId: string;
  actorUid: string;
  currentSessionId: string | null;
  proposedSessionId: string;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
  participantCount: number;
  privateLocationCount: number;
  exposedLocationCount: number;
  emergencyProjectionCount: number;
  estimatedWriteCount: number;
  sessionSchemaVersion: number;
  previewFingerprint: string;
}

export interface GameResetConfigSnapshot {
  data: Record<string, unknown>;
  revision?: string;
}

export interface GameResetReceipt {
  operation: 'executeGameReset';
  requestId: string;
  gameSessionId: string;
  confirmationToken: string;
  createdAt: number;
  result: ExecuteGameResetSuccess;
}

export interface GameResetCommit {
  adminUid: string;
  requestId: string;
  confirmationToken: string;
  completedAt: number;
  configPatch: Record<string, unknown>;
  participantIds: readonly string[];
  playerPatch: Record<string, unknown>;
  locationIds: Readonly<Record<ResetCollectionName, readonly string[]>>;
  receipt: GameResetReceipt;
}

export interface GameResetTransaction {
  readAdmin(uid: string): Promise<boolean>;
  readConfig(): Promise<GameResetConfigSnapshot | null>;
  readParticipants(): Promise<ResetParticipantDocument[]>;
  readCollection(name: ResetCollectionName): Promise<GameResetDocument[]>;
  readConfirmation(uid: string, tokenId: string): Promise<Record<string, unknown> | null>;
  readResetReceipt(uid: string, requestId: string): Promise<Record<string, unknown> | null>;
  createConfirmation(uid: string, tokenId: string, confirmation: GameResetConfirmation): void;
  writeReset(commit: GameResetCommit): void;
}

export interface GameResetStore {
  runTransaction<T>(work: (transaction: GameResetTransaction) => Promise<T>): Promise<T>;
}

export interface GameResetRuntime {
  now(): number;
  createTokenId(): string;
  createProposedSessionId(): string;
  createLogId(): string;
}

export interface PrepareGameResetSuccess {
  ok: true;
  confirmationToken: string;
  expiresAt: number;
  currentSessionId: string | null;
  proposedSessionId: string;
  sessionSchemaVersion: number;
  participantCount: number;
  privateLocationCount: number;
  exposedLocationCount: number;
  emergencyProjectionCount: number;
  estimatedWriteCount: number;
  resetReady: boolean;
  warningCodes: ResetPreviewPlan['warningCodes'];
}

export interface ExecuteGameResetSuccess {
  ok: true;
  executed: true;
  newSessionId: string;
}

function fail(reason: GameResetFailureReason): never {
  throw new GameResetServiceError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePrepareRequest(value: unknown): { expectedSessionId: string } {
  const parsed = validatePrepareGameResetRequest(value);
  if (!parsed.allowed) fail('INVALID_ARGUMENT');
  return parsed.request;
}

function parseExecuteRequest(value: unknown): { confirmationToken: string; requestId: string; expectedSessionId: string } {
  const parsed = validateExecuteGameResetRequest(value);
  if (!parsed.allowed) fail('INVALID_ARGUMENT');
  return parsed.request;
}

function fingerprint(plan: ResetPreviewPlan): string {
  return createHash('sha256').update(plan.fingerprintInput).digest('hex');
}

function validateRuntime(runtime: Pick<GameResetRuntime, 'now' | 'createTokenId' | 'createProposedSessionId'>): {
  now: number;
  tokenId: string;
  proposedSessionId: string;
} {
  const now = runtime.now();
  const tokenId = runtime.createTokenId();
  const proposedSessionId = runtime.createProposedSessionId();
  if (!Number.isFinite(now) || now < 0 || !isValidResetId(tokenId)
    || !isValidResetId(proposedSessionId) || tokenId === proposedSessionId) {
    fail('PERSISTENCE_ERROR');
  }
  return { now, tokenId, proposedSessionId };
}

interface CurrentResetPreview {
  plan: ResetPreviewPlan;
  locationDocuments: Record<ResetCollectionName, GameResetDocument[]>;
}

async function currentPreview(
  transaction: GameResetTransaction,
  expectedSessionId: string,
  existingConfig?: GameResetConfigSnapshot,
): Promise<CurrentResetPreview> {
  const configSnapshot = existingConfig ?? await transaction.readConfig();
  if (!configSnapshot) fail('CONFIG_NOT_FOUND');
  if (!validateResetConfig(configSnapshot.data).allowed) fail('INVALID_CONFIG');
  if (!validateExpectedSession(configSnapshot.data, expectedSessionId).valid) fail('SESSION_CHANGED');
  const [participants, privateLocations, exposedLocations, emergencyProjections] = await Promise.all([
    transaction.readParticipants(),
    transaction.readCollection('privateLocations'),
    transaction.readCollection('exposedLocations'),
    transaction.readCollection('emergencyLocationProjections'),
  ]);
  const documents = [...participants, ...privateLocations, ...exposedLocations, ...emergencyProjections];
  if (documents.some(document => typeof document.id !== 'string'
    || document.id.length === 0 || document.id.includes('/'))) fail('INVALID_CONFIG');
  const plan = planGameResetPreview({
    config: configSnapshot.data,
    configRevision: configSnapshot.revision,
    participants,
    privateLocations,
    exposedLocations,
    emergencyProjections,
  });
  if (!plan) fail('INVALID_CONFIG');
  return {
    plan,
    locationDocuments: { privateLocations, exposedLocations, emergencyLocationProjections: emergencyProjections },
  };
}

export async function prepareGameResetForAdmin(
  authUid: string,
  input: unknown,
  store: GameResetStore,
  runtime: Pick<GameResetRuntime, 'now' | 'createTokenId' | 'createProposedSessionId'>,
): Promise<PrepareGameResetSuccess> {
  if (typeof authUid !== 'string' || authUid.length === 0) fail('UNAUTHENTICATED');
  const { expectedSessionId } = parsePrepareRequest(input);
  const { now, tokenId, proposedSessionId } = validateRuntime(runtime);
  const expiresAt = now + RESET_CONFIRMATION_TTL_MS;
  if (!Number.isSafeInteger(expiresAt)) fail('PERSISTENCE_ERROR');

  try {
    return await store.runTransaction(async transaction => {
      if (!await transaction.readAdmin(authUid)) fail('PERMISSION_DENIED');
      const { plan } = await currentPreview(transaction, expectedSessionId);
      const previewFingerprint = fingerprint(plan);
      const confirmation: GameResetConfirmation = {
        tokenId,
        actorUid: authUid,
        currentSessionId: plan.currentSessionId,
        proposedSessionId,
        issuedAt: now,
        expiresAt,
        used: false,
        participantCount: plan.participantCount,
        privateLocationCount: plan.privateLocationCount,
        exposedLocationCount: plan.exposedLocationCount,
        emergencyProjectionCount: plan.emergencyProjectionCount,
        estimatedWriteCount: plan.estimatedWriteCount,
        sessionSchemaVersion: plan.sessionSchemaVersion,
        previewFingerprint,
      };
      transaction.createConfirmation(authUid, tokenId, confirmation);
      return {
        ok: true,
        confirmationToken: tokenId,
        expiresAt,
        currentSessionId: plan.currentSessionId,
        proposedSessionId,
        sessionSchemaVersion: plan.sessionSchemaVersion,
        participantCount: plan.participantCount,
        privateLocationCount: plan.privateLocationCount,
        exposedLocationCount: plan.exposedLocationCount,
        emergencyProjectionCount: plan.emergencyProjectionCount,
        estimatedWriteCount: plan.estimatedWriteCount,
        resetReady: isResetSessionReady(plan.sessionSchemaVersion) && !plan.tooLarge,
        warningCodes: plan.warningCodes,
      };
    });
  } catch (error) {
    if (error instanceof GameResetServiceError) throw error;
    throw new GameResetServiceError('PERSISTENCE_ERROR');
  }
}

function validateConfirmation(value: Record<string, unknown>, tokenId: string): GameResetConfirmation {
  const countFields = [
    'participantCount', 'privateLocationCount', 'exposedLocationCount',
    'emergencyProjectionCount', 'estimatedWriteCount', 'sessionSchemaVersion',
  ] as const;
  if (value.tokenId !== tokenId || typeof value.actorUid !== 'string'
    || (value.currentSessionId !== null && !isValidResetId(value.currentSessionId))
    || !isValidResetId(value.proposedSessionId)
    || !Number.isSafeInteger(value.issuedAt) || (value.issuedAt as number) < 0
    || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < 0
    || typeof value.used !== 'boolean' || typeof value.previewFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.previewFingerprint)
    || countFields.some(field => !Number.isSafeInteger(value[field]) || (value[field] as number) < 0)) {
    fail('PERSISTENCE_ERROR');
  }
  return value as unknown as GameResetConfirmation;
}

function confirmationSnapshot(value: GameResetConfirmation) {
  return {
    currentSessionId: value.currentSessionId,
    sessionSchemaVersion: value.sessionSchemaVersion,
    participantCount: value.participantCount,
    privateLocationCount: value.privateLocationCount,
    exposedLocationCount: value.exposedLocationCount,
    emergencyProjectionCount: value.emergencyProjectionCount,
    estimatedWriteCount: value.estimatedWriteCount,
    fingerprint: value.previewFingerprint,
  };
}

function readPriorReceipt(
  value: Record<string, unknown>,
  request: ReturnType<typeof parseExecuteRequest>,
): ExecuteGameResetSuccess {
  const replay = resolveResetReceiptReplay(
    value,
    request.requestId,
    request.expectedSessionId,
    request.confirmationToken,
  );
  if (replay === 'SESSION_CHANGED') fail('SESSION_CHANGED');
  if (replay === 'REQUEST_ID_REUSED' || replay === 'INVALID_RECEIPT') fail('REQUEST_ID_REUSED');
  if (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
    || !isRecord(value.result) || Object.keys(value.result).length !== 3
    || value.result.ok !== true || value.result.executed !== true
    || !isValidResetId(value.result.newSessionId)) fail('PERSISTENCE_ERROR');
  return { ok: true, executed: true, newSessionId: value.result.newSessionId };
}

function resetConfigPatch(
  config: Record<string, unknown>,
  proposedSessionId: string,
  now: number,
  actorUid: string,
  logId: string,
): Record<string, unknown> {
  const planned = planFutureGameResetConfig({
    proposedSessionId,
    resetAt: now,
    nextRevealTime: now,
  });
  if (!planned) fail('INVALID_CONFIG');
  const { clearRevealDeadlines, preserveLogCount, ...patch } = planned;
  const audit = {
    id: logId,
    timestamp: now,
    type: 'SYSTEM',
    actorUid,
    action: 'executeGameReset',
    previousSessionId: config.gameSessionId,
    gameSessionId: proposedSessionId,
    sessionSchemaVersion: planned.sessionSchemaVersion,
    message: `Game reset completed (${proposedSessionId})`,
  };
  const configPatch: Record<string, unknown> = {
    ...patch,
    logs: [audit, ...((config.logs ?? []) as unknown[]).slice(0, preserveLogCount)],
  };
  for (const field of clearRevealDeadlines) configPatch[field] = null;
  return configPatch;
}

function locationIdsForParticipants(
  documents: readonly GameResetDocument[],
  participantIds: ReadonlySet<string>,
): string[] {
  return documents.filter(document => participantIds.has(document.id)).map(document => document.id);
}

export async function executeGameResetForAdmin(
  authUid: string,
  input: unknown,
  store: GameResetStore,
  runtime: Pick<GameResetRuntime, 'now' | 'createLogId'>,
): Promise<ExecuteGameResetSuccess> {
  if (typeof authUid !== 'string' || authUid.length === 0) fail('UNAUTHENTICATED');
  const request = parseExecuteRequest(input);
  const now = runtime.now();
  const logId = runtime.createLogId();
  if (!Number.isSafeInteger(now) || now < 0 || !isValidResetId(logId)) fail('PERSISTENCE_ERROR');

  try {
    return await store.runTransaction(async transaction => {
      if (!await transaction.readAdmin(authUid)) fail('PERMISSION_DENIED');
      const priorReceipt = await transaction.readResetReceipt(authUid, request.requestId);
      if (priorReceipt) return readPriorReceipt(priorReceipt, request);

      const configSnapshot = await transaction.readConfig();
      if (!configSnapshot) fail('CONFIG_NOT_FOUND');
      if (!validateResetConfig(configSnapshot.data).allowed) fail('INVALID_CONFIG');
      if (!validateExpectedSession(configSnapshot.data, request.expectedSessionId).valid) fail('SESSION_CHANGED');

      const rawConfirmation = await transaction.readConfirmation(authUid, request.confirmationToken);
      if (!rawConfirmation) fail('CONFIRMATION_NOT_FOUND');
      const confirmation = validateConfirmation(rawConfirmation, request.confirmationToken);
      if (confirmation.actorUid !== authUid) fail('PERMISSION_DENIED');
      if (confirmation.currentSessionId !== request.expectedSessionId) fail('SESSION_CHANGED');
      if (confirmation.proposedSessionId === request.expectedSessionId) fail('PERSISTENCE_ERROR');
      if (isResetConfirmationExpired(confirmation.expiresAt, now)) fail('CONFIRMATION_EXPIRED');
      if (confirmation.used) fail('CONFIRMATION_ALREADY_USED');

      const { plan, locationDocuments } = await currentPreview(transaction, request.expectedSessionId, configSnapshot);
      if (plan.currentSessionId !== confirmation.currentSessionId
        || plan.sessionSchemaVersion !== confirmation.sessionSchemaVersion) fail('SESSION_CHANGED');
      if (isResetConfirmationStale(confirmationSnapshot(confirmation), plan, fingerprint(plan))) {
        fail('CONFIRMATION_STALE');
      }
      if (plan.estimatedWriteCount > RESET_MAX_ESTIMATED_WRITES) fail('RESET_TOO_LARGE');
      if (!isResetSessionReady(plan.sessionSchemaVersion)) fail('RESET_NOT_READY');

      const playerPatch = planFuturePlayerReset(confirmation.proposedSessionId);
      if (!playerPatch) fail('PERSISTENCE_ERROR');
      const receiptContract = buildResetReceiptContract(
        request.requestId,
        request.expectedSessionId,
        request.confirmationToken,
        confirmation.proposedSessionId,
      );
      if (!receiptContract) fail('PERSISTENCE_ERROR');
      const result = receiptContract.result;
      const receipt: GameResetReceipt = {
        ...receiptContract,
        createdAt: now,
        result,
      };
      const participantIds = new Set(plan.participantIds);
      const commit: GameResetCommit = {
        adminUid: authUid,
        requestId: request.requestId,
        confirmationToken: request.confirmationToken,
        completedAt: now,
        configPatch: resetConfigPatch(configSnapshot.data, confirmation.proposedSessionId, now, authUid, logId),
        participantIds: plan.participantIds,
        playerPatch: { ...playerPatch },
        locationIds: {
          privateLocations: locationIdsForParticipants(locationDocuments.privateLocations, participantIds),
          exposedLocations: locationIdsForParticipants(locationDocuments.exposedLocations, participantIds),
          emergencyLocationProjections: locationIdsForParticipants(locationDocuments.emergencyLocationProjections, participantIds),
        },
        receipt,
      };
      transaction.writeReset(commit);
      return result;
    });
  } catch (error) {
    if (error instanceof GameResetServiceError) throw error;
    throw new GameResetServiceError('PERSISTENCE_ERROR');
  }
}
