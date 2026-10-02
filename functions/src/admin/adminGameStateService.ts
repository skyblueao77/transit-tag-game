import {
  resolveAdminPlayerResume,
  resolveAdminRoleSwap,
} from '../../../src/game/adminGameState';
import type {
  AdminRoleSwapPlayer,
  AdminRoleSwapPlayerChange,
  AdminPlayerStatus,
} from '../../../src/game/adminGameState';
import type { Role } from '../../../src/game/types';

export type AdminGameStateFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_PLAYER_STATE'
  | 'INVALID_TEAM'
  | 'INVALID_GAME_CONFIG'
  | 'INVALID_ROSTER'
  | 'INVALID_STATUS'
  | 'ROSTER_TOO_LARGE'
  | 'PERSISTENCE_ERROR';

export class AdminGameStateServiceError extends Error {
  constructor(readonly reason: AdminGameStateFailureReason) {
    super(reason);
    this.name = 'AdminGameStateServiceError';
  }
}

export interface AdminPlayerDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface AdminPlayerUpdates {
  status: 'ACTIVE' | 'WAITING';
  waitingUntil: number;
  shinkansenStartTime: null;
  invincibleUntil?: 0;
}

export interface AdminConfigUpdates {
  teamARole: Role;
  teamBRole: Role;
  nextRevealTime: number;
}

export interface AdminRoleSwapReceipt {
  action: 'swapTeamRoles';
  requestId: string;
  teamARole: Role;
  teamBRole: Role;
  nextRevealTime: number;
  newOniTeam: 'A' | 'B';
}

export interface AdminGameStateTransaction {
  readAdmin(uid: string): Promise<boolean>;
  readRoleSwapReceipt(uid: string, requestId: string): Promise<Record<string, unknown> | null>;
  readGameConfig(): Promise<Record<string, unknown> | null>;
  readParticipantRoster(): Promise<AdminPlayerDocument[]>;
  readPlayer(playerId: string): Promise<AdminPlayerDocument | null>;
  writeRoleSwap(
    adminUid: string,
    config: AdminConfigUpdates,
    players: readonly { playerId: string; updates: AdminPlayerUpdates }[],
    logs: unknown[],
    receipt: AdminRoleSwapReceipt,
  ): void;
  writePlayer(playerId: string, updates: AdminPlayerUpdates): void;
  writeLogs(logs: unknown[]): void;
}

export interface AdminGameStateStore {
  runTransaction<T>(work: (transaction: AdminGameStateTransaction) => Promise<T>): Promise<T>;
}

export interface AdminGameStateRuntime {
  now(): number;
  createLogId(): string;
}

export interface AdminRoleSwapSuccess {
  ok: true;
  replayed: boolean;
  teamARole: Role;
  teamBRole: Role;
  nextRevealTime: number;
  newOniTeam: 'A' | 'B';
}

export interface AdminPlayerResumeSuccess {
  ok: true;
  resumed: boolean;
  status: 'ACTIVE';
}

const statuses: readonly AdminPlayerStatus[] = [
  'ACTIVE', 'WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED',
];
const roles: readonly Role[] = ['ONI', 'RUNNER'];
const MAX_TRANSACTION_WRITES = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidArgument(): never {
  throw new AdminGameStateServiceError('INVALID_ARGUMENT');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRoleSwapRequest(request: unknown): { requestId: string } {
  if (!isRecord(request)
    || Object.keys(request).length !== 1
    || !Object.prototype.hasOwnProperty.call(request, 'requestId')
    || typeof request.requestId !== 'string'
    || !UUID_PATTERN.test(request.requestId)) {
    return invalidArgument();
  }
  return { requestId: request.requestId };
}

function isValidDocumentId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= 128
    && !value.includes('/')
    && !value.includes('\0')
    && value !== '.'
    && value !== '..';
}

function parseResumeRequest(request: unknown): { targetId: string } {
  if (!isRecord(request)
    || Object.keys(request).length !== 1
    || !Object.prototype.hasOwnProperty.call(request, 'targetId')
    || !isValidDocumentId(request.targetId)) {
    return invalidArgument();
  }
  return { targetId: request.targetId };
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function validateConfig(config: Record<string, unknown> | null): Record<string, unknown> {
  if (!config) throw new AdminGameStateServiceError('CONFIG_NOT_FOUND');
  if (!roles.includes(config.teamARole as Role)
    || !roles.includes(config.teamBRole as Role)
    || config.teamARole === config.teamBRole
    || !isOptionalTimestamp(config.nextRevealTime)
    || (config.logs !== undefined && !Array.isArray(config.logs))) {
    throw new AdminGameStateServiceError('INVALID_GAME_CONFIG');
  }
  return config;
}

function validatePlayerDocument(document: AdminPlayerDocument): AdminRoleSwapPlayer {
  const player = document.data;
  if (document.id.trim().length === 0
    || player.id !== document.id
    || typeof player.name !== 'string'
    || player.name.trim().length === 0
    || (player.team !== 'A' && player.team !== 'B')
    || typeof player.status !== 'string'
    || !statuses.includes(player.status as AdminPlayerStatus)
    || !isOptionalTimestamp(player.waitingUntil)
    || !isOptionalTimestamp(player.shinkansenStartTime)
    || !isOptionalTimestamp(player.invincibleUntil)
    || !Number.isInteger(player.invincibleCards)
    || (player.invincibleCards as number) < 0
    || typeof player.score !== 'number'
    || !Number.isFinite(player.score)) {
    throw new AdminGameStateServiceError('INVALID_ROSTER');
  }
  return {
    id: document.id,
    team: player.team,
    status: player.status,
  };
}

function validateResumePlayer(document: AdminPlayerDocument | null, targetId: string): Record<string, unknown> {
  if (!document) throw new AdminGameStateServiceError('PLAYER_NOT_FOUND');
  const player = document.data;
  if (document.id !== targetId
    || player.id !== targetId
    || typeof player.name !== 'string'
    || player.name.trim().length === 0
    || typeof player.status !== 'string'
    || !statuses.includes(player.status as AdminPlayerStatus)
    || !isOptionalTimestamp(player.waitingUntil)
    || !isOptionalTimestamp(player.shinkansenStartTime)
    || !isOptionalTimestamp(player.invincibleUntil)
    || !Number.isInteger(player.invincibleCards)
    || (player.invincibleCards as number) < 0
    || typeof player.score !== 'number'
    || !Number.isFinite(player.score)) {
    throw new AdminGameStateServiceError('INVALID_PLAYER_STATE');
  }
  if (player.team !== 'A' && player.team !== 'B') {
    throw new AdminGameStateServiceError('INVALID_TEAM');
  }
  return player;
}

function readReceipt(data: Record<string, unknown>, requestId: string): AdminRoleSwapSuccess {
  if (data.action !== 'swapTeamRoles'
    || data.requestId !== requestId
    || !roles.includes(data.teamARole as Role)
    || !roles.includes(data.teamBRole as Role)
    || data.teamARole === data.teamBRole
    || !isOptionalTimestamp(data.nextRevealTime)
    || typeof data.nextRevealTime !== 'number'
    || (data.newOniTeam !== 'A' && data.newOniTeam !== 'B')) {
    throw new AdminGameStateServiceError('PERSISTENCE_ERROR');
  }
  return {
    ok: true,
    replayed: true,
    teamARole: data.teamARole as Role,
    teamBRole: data.teamBRole as Role,
    nextRevealTime: data.nextRevealTime,
    newOniTeam: data.newOniTeam,
  };
}

function createLogs(config: Record<string, unknown>, log: Record<string, unknown>): unknown[] {
  return [log, ...((config.logs ?? []) as unknown[])].slice(0, 200);
}

function validateRuntime(runtime: AdminGameStateRuntime): { now: number; logId: string } {
  const now = runtime.now();
  const logId = runtime.createLogId();
  if (!Number.isFinite(now) || now < 0 || typeof logId !== 'string' || logId.length === 0) {
    throw new AdminGameStateServiceError('PERSISTENCE_ERROR');
  }
  return { now, logId };
}

function throwCoreRejection(reason: string): never {
  if (reason === 'INVALID_STATUS') throw new AdminGameStateServiceError('INVALID_STATUS');
  if (reason === 'INVALID_ROLES' || reason === 'INVALID_TIME') {
    throw new AdminGameStateServiceError('INVALID_GAME_CONFIG');
  }
  throw new AdminGameStateServiceError('INVALID_ROSTER');
}

export async function swapTeamRolesForAdmin(
  authUid: string,
  request: unknown,
  store: AdminGameStateStore,
  runtime: AdminGameStateRuntime,
): Promise<AdminRoleSwapSuccess> {
  if (typeof authUid !== 'string' || authUid.length === 0) {
    throw new AdminGameStateServiceError('UNAUTHENTICATED');
  }
  const { requestId } = parseRoleSwapRequest(request);
  const { now, logId } = validateRuntime(runtime);

  try {
    return await store.runTransaction(async transaction => {
      const authorized = await transaction.readAdmin(authUid);
      if (!authorized) throw new AdminGameStateServiceError('PERMISSION_DENIED');

      const priorReceipt = await transaction.readRoleSwapReceipt(authUid, requestId);
      if (priorReceipt) return readReceipt(priorReceipt, requestId);

      const [rawConfig, documents] = await Promise.all([
        transaction.readGameConfig(),
        transaction.readParticipantRoster(),
      ]);
      const config = validateConfig(rawConfig);
      const roster = documents.map(validatePlayerDocument);
      const result = resolveAdminRoleSwap({
        teamRoles: {
          teamARole: config.teamARole as Role,
          teamBRole: config.teamBRole as Role,
        },
        players: roster,
        now,
      });
      if (!result.allowed) throwCoreRejection(result.reason);
      if (result.playerChanges.length + 2 > MAX_TRANSACTION_WRITES) {
        throw new AdminGameStateServiceError('ROSTER_TOO_LARGE');
      }

      const log = {
        id: logId,
        timestamp: now,
        message: `【運営操作】攻守を強制的に交代しました (新・鬼: Team ${result.newOniTeam})`,
        type: 'SYSTEM' as const,
      };
      const receipt: AdminRoleSwapReceipt = {
        action: 'swapTeamRoles',
        requestId,
        teamARole: result.teamRoles.teamARole,
        teamBRole: result.teamRoles.teamBRole,
        nextRevealTime: result.nextRevealTime,
        newOniTeam: result.newOniTeam,
      };
      const playerChanges = result.playerChanges.map(change => ({
        playerId: change.playerId,
        updates: toPlayerUpdates(change),
      }));
      transaction.writeRoleSwap(
        authUid,
        {
          ...result.teamRoles,
          nextRevealTime: result.nextRevealTime,
        },
        playerChanges,
        createLogs(config, log),
        receipt,
      );
      return {
        ok: true,
        replayed: false,
        teamARole: result.teamRoles.teamARole,
        teamBRole: result.teamRoles.teamBRole,
        nextRevealTime: result.nextRevealTime,
        newOniTeam: result.newOniTeam,
      };
    });
  } catch (error) {
    if (error instanceof AdminGameStateServiceError) throw error;
    throw new AdminGameStateServiceError('PERSISTENCE_ERROR');
  }
}

function toPlayerUpdates(change: AdminRoleSwapPlayerChange): AdminPlayerUpdates {
  return {
    status: change.status,
    waitingUntil: change.waitingUntil,
    shinkansenStartTime: change.shinkansenStartTime,
    ...(change.invincibleUntil === undefined ? {} : { invincibleUntil: change.invincibleUntil }),
  };
}

export async function resumePlayerForAdmin(
  authUid: string,
  request: unknown,
  store: AdminGameStateStore,
  runtime: AdminGameStateRuntime,
): Promise<AdminPlayerResumeSuccess> {
  if (typeof authUid !== 'string' || authUid.length === 0) {
    throw new AdminGameStateServiceError('UNAUTHENTICATED');
  }
  const { targetId } = parseResumeRequest(request);
  const { now, logId } = validateRuntime(runtime);

  try {
    return await store.runTransaction(async transaction => {
      const [authorized, document, rawConfig] = await Promise.all([
        transaction.readAdmin(authUid),
        transaction.readPlayer(targetId),
        transaction.readGameConfig(),
      ]);
      if (!authorized) throw new AdminGameStateServiceError('PERMISSION_DENIED');
      const player = validateResumePlayer(document, targetId);
      const config = validateConfig(rawConfig);
      const result = resolveAdminPlayerResume({ status: player.status as string });
      if (!result.allowed) throwCoreRejection(result.reason);
      if (!result.changed) return { ok: true, resumed: false, status: 'ACTIVE' };

      const log = {
        id: logId,
        timestamp: now,
        message: `【運営操作】Team ${player.team} ${player.name} を ${player.status} から ACTIVE に復帰しました`,
        type: 'SYSTEM' as const,
      };
      transaction.writePlayer(targetId, {
        status: result.status,
        waitingUntil: result.waitingUntil,
        shinkansenStartTime: result.shinkansenStartTime,
        ...(result.invincibleUntil === undefined ? {} : { invincibleUntil: result.invincibleUntil }),
      });
      transaction.writeLogs(createLogs(config, log));
      return { ok: true, resumed: true, status: 'ACTIVE' };
    });
  } catch (error) {
    if (error instanceof AdminGameStateServiceError) throw error;
    throw new AdminGameStateServiceError('PERSISTENCE_ERROR');
  }
}
