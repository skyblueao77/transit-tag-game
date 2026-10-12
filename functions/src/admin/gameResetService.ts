import { createHash } from 'node:crypto';
import {
  isResetConfirmationExpired,
  isResetConfirmationStale,
  isResetSessionReady,
  isValidResetId,
  planGameResetPreview,
  RESET_CONFIRMATION_TTL_MS,
  RESET_MAX_ESTIMATED_WRITES,
  validateExecuteGameResetRequest,
  validatePrepareGameResetRequest,
  validateResetConfig,
} from '../../../src/game/gameReset';
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
  used: false;
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

export interface GameResetTransaction {
  readAdmin(uid: string): Promise<boolean>;
  readConfig(): Promise<GameResetConfigSnapshot | null>;
  readParticipants(): Promise<ResetParticipantDocument[]>;
  readCollection(name: ResetCollectionName): Promise<GameResetDocument[]>;
  readConfirmation(uid: string, tokenId: string): Promise<Record<string, unknown> | null>;
  createConfirmation(uid: string, tokenId: string, confirmation: GameResetConfirmation): void;
}

export interface GameResetStore {
  runTransaction<T>(work: (transaction: GameResetTransaction) => Promise<T>): Promise<T>;
}

export interface GameResetRuntime {
  now(): number;
  createTokenId(): string;
  createProposedSessionId(): string;
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
  resetReady: false;
  warningCodes: ResetPreviewPlan['warningCodes'];
}

function fail(reason: GameResetFailureReason): never {
  throw new GameResetServiceError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePrepareRequest(value: unknown): void {
  if (!validatePrepareGameResetRequest(value).allowed) fail('INVALID_ARGUMENT');
}

function parseExecuteRequest(value: unknown): { confirmationToken: string; requestId: string } {
  const parsed = validateExecuteGameResetRequest(value);
  if (!parsed.allowed) fail('INVALID_ARGUMENT');
  return parsed.request;
}

function fingerprint(plan: ResetPreviewPlan): string {
  return createHash('sha256').update(plan.fingerprintInput).digest('hex');
}

function validateRuntime(runtime: GameResetRuntime): {
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

async function currentPreview(transaction: GameResetTransaction): Promise<ResetPreviewPlan> {
  const [configSnapshot, participants, privateLocations, exposedLocations, emergencyProjections] = await Promise.all([
    transaction.readConfig(),
    transaction.readParticipants(),
    transaction.readCollection('privateLocations'),
    transaction.readCollection('exposedLocations'),
    transaction.readCollection('emergencyLocationProjections'),
  ]);
  if (!configSnapshot) fail('CONFIG_NOT_FOUND');
  if (!validateResetConfig(configSnapshot.data).allowed) fail('INVALID_CONFIG');
  const plan = planGameResetPreview({
    config: configSnapshot.data,
    configRevision: configSnapshot.revision,
    participants,
    privateLocations,
    exposedLocations,
    emergencyProjections,
  });
  if (!plan) fail('INVALID_CONFIG');
  return plan;
}

export async function prepareGameResetForAdmin(
  authUid: string,
  input: unknown,
  store: GameResetStore,
  runtime: GameResetRuntime,
): Promise<PrepareGameResetSuccess> {
  if (typeof authUid !== 'string' || authUid.length === 0) fail('UNAUTHENTICATED');
  parsePrepareRequest(input);
  const { now, tokenId, proposedSessionId } = validateRuntime(runtime);
  const expiresAt = now + RESET_CONFIRMATION_TTL_MS;
  if (!Number.isSafeInteger(expiresAt)) fail('PERSISTENCE_ERROR');

  try {
    return await store.runTransaction(async transaction => {
      if (!await transaction.readAdmin(authUid)) fail('PERMISSION_DENIED');
      const plan = await currentPreview(transaction);
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
        resetReady: false,
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
    || (value.currentSessionId !== null && typeof value.currentSessionId !== 'string')
    || !isValidResetId(value.proposedSessionId)
    || !Number.isFinite(value.issuedAt) || !Number.isFinite(value.expiresAt)
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

export async function executeGameResetForAdmin(
  authUid: string,
  input: unknown,
  store: GameResetStore,
  runtime: Pick<GameResetRuntime, 'now'>,
): Promise<never> {
  if (typeof authUid !== 'string' || authUid.length === 0) fail('UNAUTHENTICATED');
  const request = parseExecuteRequest(input);
  const now = runtime.now();
  if (!Number.isFinite(now) || now < 0) fail('PERSISTENCE_ERROR');

  try {
    return await store.runTransaction(async transaction => {
      if (!await transaction.readAdmin(authUid)) fail('PERMISSION_DENIED');
      const rawConfirmation = await transaction.readConfirmation(authUid, request.confirmationToken);
      if (!rawConfirmation) fail('CONFIRMATION_NOT_FOUND');
      const confirmation = validateConfirmation(rawConfirmation, request.confirmationToken);
      if (confirmation.actorUid !== authUid) fail('PERMISSION_DENIED');
      if (isResetConfirmationExpired(confirmation.expiresAt, now)) fail('CONFIRMATION_EXPIRED');
      if (confirmation.used) fail('CONFIRMATION_ALREADY_USED');

      const plan = await currentPreview(transaction);
      if (plan.currentSessionId !== confirmation.currentSessionId
        || plan.sessionSchemaVersion !== confirmation.sessionSchemaVersion) fail('SESSION_CHANGED');
      if (isResetConfirmationStale(confirmationSnapshot(confirmation), plan, fingerprint(plan))) {
        fail('CONFIRMATION_STALE');
      }
      if (plan.estimatedWriteCount > RESET_MAX_ESTIMATED_WRITES) fail('RESET_TOO_LARGE');
      if (!isResetSessionReady(plan.sessionSchemaVersion)) fail('RESET_NOT_READY');

      // The reset remains server-disabled in this PR even if a caller spoofs schema readiness.
      fail('RESET_NOT_READY');
    });
  } catch (error) {
    if (error instanceof GameResetServiceError) throw error;
    throw new GameResetServiceError('PERSISTENCE_ERROR');
  }
}
