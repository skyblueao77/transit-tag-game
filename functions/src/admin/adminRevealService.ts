import {
  MAX_ADMIN_REVEAL_DURATION_MINUTES,
  MIN_ADMIN_REVEAL_DURATION_MINUTES,
  resolveAdminRevealPlan,
} from '../../../src/game/adminReveal';
import type {
  AdminRevealConfigField,
  AdminRevealPlayer,
  AdminRevealScope,
  AdminRevealSnapshot,
} from '../../../src/game/adminReveal';

export type AdminRevealFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_GAME_CONFIG'
  | 'INVALID_ROSTER'
  | 'ZERO_VALID_LOCATIONS'
  | 'WRITE_LIMIT_EXCEEDED'
  | 'PERSISTENCE_ERROR';

export class AdminRevealServiceError extends Error {
  constructor(readonly reason: AdminRevealFailureReason) {
    super(reason);
    this.name = 'AdminRevealServiceError';
  }
}

export interface AdminRevealDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface AdminRevealReceipt {
  action: 'revealPlayerLocations';
  requestId: string;
  scope: AdminRevealScope;
  expiresAt: number;
  projectedCount: number;
  skippedCount: number;
  createdAt: number;
}

export interface AdminRevealTransaction {
  readAdmin(uid: string): Promise<boolean>;
  readReceipt(uid: string, requestId: string): Promise<Record<string, unknown> | null>;
  readGameConfig(): Promise<Record<string, unknown> | null>;
  readParticipantRoster(): Promise<AdminRevealDocument[]>;
  readPrivateLocations(playerIds: readonly string[]): Promise<AdminRevealDocument[]>;
  readExistingSnapshots(playerIds: readonly string[]): Promise<AdminRevealDocument[]>;
  writeReveal(
    adminUid: string,
    configField: AdminRevealConfigField,
    expiresAt: number,
    snapshots: readonly AdminRevealSnapshot[],
    logs: unknown[],
    receipt: AdminRevealReceipt,
  ): void;
}

export interface AdminRevealStore {
  runTransaction<T>(work: (transaction: AdminRevealTransaction) => Promise<T>): Promise<T>;
}

export interface AdminRevealRuntime {
  now(): number;
  createLogId(): string;
}

export interface AdminRevealSuccess {
  ok: true;
  scope: AdminRevealScope;
  expiresAt: number;
  projectedCount: number;
  skippedCount: number;
  duplicate: boolean;
}

const MAX_TRANSACTION_WRITES = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const knownStatuses = ['ACTIVE', 'WAITING', 'CAPTURED', 'EMERGENCY', 'RETIRED'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(request: unknown): { scope: AdminRevealScope; durationMinutes: number; requestId: string } {
  if (!isRecord(request)
    || Object.keys(request).length !== 3
    || !Object.prototype.hasOwnProperty.call(request, 'scope')
    || !Object.prototype.hasOwnProperty.call(request, 'durationMinutes')
    || !Object.prototype.hasOwnProperty.call(request, 'requestId')
    || (request.scope !== 'GLOBAL' && request.scope !== 'TEAM_A' && request.scope !== 'TEAM_B')
    || typeof request.durationMinutes !== 'number'
    || !Number.isInteger(request.durationMinutes)
    || request.durationMinutes < MIN_ADMIN_REVEAL_DURATION_MINUTES
    || request.durationMinutes > MAX_ADMIN_REVEAL_DURATION_MINUTES
    || typeof request.requestId !== 'string'
    || !UUID_PATTERN.test(request.requestId)) {
    throw new AdminRevealServiceError('INVALID_ARGUMENT');
  }
  return {
    scope: request.scope,
    durationMinutes: request.durationMinutes,
    requestId: request.requestId,
  };
}

function timestampMillis(value: unknown): number | null {
  if (value && typeof value === 'object'
    && 'toMillis' in value
    && typeof value.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function validateConfig(config: Record<string, unknown> | null): Record<string, unknown> {
  if (!config) throw new AdminRevealServiceError('CONFIG_NOT_FOUND');
  if (config.logs !== undefined && !Array.isArray(config.logs)) {
    throw new AdminRevealServiceError('INVALID_GAME_CONFIG');
  }
  return config;
}

function validateRoster(documents: readonly AdminRevealDocument[]): AdminRevealPlayer[] {
  const roster: AdminRevealPlayer[] = [];
  const ids = new Set<string>();
  for (const document of documents) {
    const player = document.data;
    if (document.id.trim().length === 0
      || player.id !== document.id
      || typeof player.team !== 'string' || player.team.trim().length === 0
      || typeof player.status !== 'string'
      || !knownStatuses.includes(player.status as typeof knownStatuses[number])
      || ids.has(document.id)) {
      throw new AdminRevealServiceError('INVALID_ROSTER');
    }
    ids.add(document.id);
    roster.push({ id: document.id, team: player.team, status: player.status });
  }
  return roster;
}

function privateLocationTargetIds(roster: readonly AdminRevealPlayer[], scope: AdminRevealScope): string[] {
  return roster
    .filter(player => (player.team === 'A' || player.team === 'B')
      && (scope === 'GLOBAL' || player.team === (scope === 'TEAM_A' ? 'A' : 'B'))
      && player.status !== 'EMERGENCY' && player.status !== 'RETIRED')
    .map(player => player.id);
}

function readReceipt(data: Record<string, unknown>, requestId: string): AdminRevealSuccess {
  const expiresAt = timestampMillis(data.expiresAt);
  if (data.action !== 'revealPlayerLocations'
    || data.requestId !== requestId
    || (data.scope !== 'GLOBAL' && data.scope !== 'TEAM_A' && data.scope !== 'TEAM_B')
    || expiresAt === null
    || !Number.isInteger(data.projectedCount) || (data.projectedCount as number) <= 0
    || !Number.isInteger(data.skippedCount) || (data.skippedCount as number) < 0) {
    throw new AdminRevealServiceError('PERSISTENCE_ERROR');
  }
  return {
    ok: true,
    scope: data.scope,
    expiresAt,
    projectedCount: data.projectedCount as number,
    skippedCount: data.skippedCount as number,
    duplicate: true,
  };
}

function createLogs(config: Record<string, unknown>, log: Record<string, unknown>): unknown[] {
  return [log, ...((config.logs ?? []) as unknown[])].slice(0, 200);
}

function throwCoreRejection(reason: string): never {
  if (reason === 'INVALID_SCOPE' || reason === 'INVALID_DURATION' || reason === 'INVALID_TIME') {
    throw new AdminRevealServiceError('INVALID_ARGUMENT');
  }
  if (reason === 'ZERO_VALID_LOCATIONS') throw new AdminRevealServiceError('ZERO_VALID_LOCATIONS');
  throw new AdminRevealServiceError('INVALID_ROSTER');
}

export async function revealPlayerLocationsForAdmin(
  authUid: string,
  request: unknown,
  store: AdminRevealStore,
  runtime: AdminRevealRuntime,
): Promise<AdminRevealSuccess> {
  if (typeof authUid !== 'string' || authUid.length === 0) {
    throw new AdminRevealServiceError('UNAUTHENTICATED');
  }
  const { scope, durationMinutes, requestId } = parseRequest(request);
  const now = runtime.now();
  const logId = runtime.createLogId();
  if (!Number.isFinite(now) || now < 0 || typeof logId !== 'string' || logId.length === 0) {
    throw new AdminRevealServiceError('PERSISTENCE_ERROR');
  }

  try {
    return await store.runTransaction(async transaction => {
      if (!await transaction.readAdmin(authUid)) {
        throw new AdminRevealServiceError('PERMISSION_DENIED');
      }
      const priorReceipt = await transaction.readReceipt(authUid, requestId);
      if (priorReceipt) return readReceipt(priorReceipt, requestId);

      const [rawConfig, rosterDocuments] = await Promise.all([
        transaction.readGameConfig(),
        transaction.readParticipantRoster(),
      ]);
      const config = validateConfig(rawConfig);
      const roster = validateRoster(rosterDocuments);
      const targetIds = privateLocationTargetIds(roster, scope);
      const [privateLocations] = await Promise.all([
        transaction.readPrivateLocations(targetIds),
        transaction.readExistingSnapshots(targetIds),
      ]);
      const locations = privateLocations.map(document => ({
        id: document.id,
        latitude: document.data.latitude,
        longitude: document.data.longitude,
        updatedAt: timestampMillis(document.data.updatedAt),
      }));
      const plan = resolveAdminRevealPlan({ scope, durationMinutes, roster, locations, now });
      if (!plan.allowed) throwCoreRejection(plan.reason);
      if (plan.snapshots.length + 2 > MAX_TRANSACTION_WRITES) {
        throw new AdminRevealServiceError('WRITE_LIMIT_EXCEEDED');
      }

      const receipt: AdminRevealReceipt = {
        action: 'revealPlayerLocations',
        requestId,
        scope,
        expiresAt: plan.expiresAt,
        projectedCount: plan.snapshots.length,
        skippedCount: plan.skipped.length,
        createdAt: now,
      };
      const log = {
        id: logId,
        timestamp: now,
        message: `【運営操作:${authUid}】${scope} 位置情報公開 (${durationMinutes}分、公開${plan.snapshots.length}名、除外${plan.skipped.length}名)`,
        type: 'SYSTEM' as const,
      };
      transaction.writeReveal(
        authUid,
        plan.configField,
        plan.expiresAt,
        plan.snapshots,
        createLogs(config, log),
        receipt,
      );
      return {
        ok: true,
        scope,
        expiresAt: plan.expiresAt,
        projectedCount: plan.snapshots.length,
        skippedCount: plan.skipped.length,
        duplicate: false,
      };
    });
  } catch (error) {
    if (error instanceof AdminRevealServiceError) throw error;
    throw new AdminRevealServiceError('PERSISTENCE_ERROR');
  }
}
