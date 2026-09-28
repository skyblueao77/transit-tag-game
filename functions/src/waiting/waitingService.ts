import { getTeamRole } from '../../../src/game/roles';
import {

  resumeExpiredWaiting,
  startManualWaiting,
  startShinkansenLimitWaiting,
} from '../../../src/game/waitingLifecycle';
import type { GameStatus, Role } from '../../../src/game/types';
import type { WaitingRejectionReason } from '../../../src/game/waitingLifecycle';

export type WaitingFailureReason =
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_PLAYER_STATE'
  | 'INVALID_GAME_CONFIG'
  | 'INVALID_TEAM'
  | 'PERSISTENCE_ERROR'
  | WaitingRejectionReason;

export class WaitingServiceError extends Error {
  constructor(readonly reason: WaitingFailureReason) {
    super(reason);
    this.name = 'WaitingServiceError';
  }
}

export interface WaitingPlayerDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface WaitingLog {
  id: string;
  timestamp: number;
  message: string;
  type: 'SYSTEM';
}

export interface WaitingPlayerUpdates {
  status: 'WAITING' | 'ACTIVE';
  waitingUntil: number;
  shinkansenStartTime: null;
}

export interface WaitingTransaction {
  readPlayer(uid: string): Promise<WaitingPlayerDocument | null>;
  readGameConfig(): Promise<Record<string, unknown> | null>;
  writePlayer(uid: string, updates: WaitingPlayerUpdates): void;
  writeLogs(logs: unknown[]): void;
}

export interface WaitingStore {
  runTransaction<T>(work: (transaction: WaitingTransaction) => Promise<T>): Promise<T>;
  listParticipantIds(): Promise<string[]>;
}

export interface WaitingRuntime {
  now(): number;
  createLogId(): string;
}

export interface StartWaitingResult {
  ok: true;
  waitingUntil: number;
  duration: number;
}

export interface ResumeWaitingResult {
  ok: true;
  resumed: boolean;
}

export type ScheduledWaitingResult =
  | { outcome: 'SKIPPED'; reason: string }
  | { outcome: 'RESUMED' }
  | { outcome: 'SHINKANSEN_WAIT_STARTED' };

const playerStatuses = ['ACTIVE', 'WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED'] as const;
const gameStatuses: readonly GameStatus[] = [
  'PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED',
  'DAY2_ACTIVE', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER',
];
const roles: readonly Role[] = ['ONI', 'RUNNER'];

function isGameStatus(value: unknown): value is GameStatus {
  return typeof value === 'string' && gameStatuses.includes(value as GameStatus);
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && roles.includes(value as Role);
}

function readPlayer(document: WaitingPlayerDocument | null, uid: string): Record<string, unknown> {
  if (!document) throw new WaitingServiceError('PLAYER_NOT_FOUND');
  const player = document.data;
  if (document.id !== uid
    || player.id !== uid
    || typeof player.name !== 'string'
    || player.name.trim().length === 0
    || typeof player.status !== 'string'
    || !playerStatuses.includes(player.status as typeof playerStatuses[number])
    || !isOptionalTimestamp(player.waitingUntil)
    || !isOptionalTimestamp(player.shinkansenStartTime)) {
    throw new WaitingServiceError('INVALID_PLAYER_STATE');
  }
  if (player.team !== 'A' && player.team !== 'B') {
    throw new WaitingServiceError('INVALID_TEAM');
  }
  return player;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function readConfig(config: Record<string, unknown> | null): Record<string, unknown> {
  if (!config) throw new WaitingServiceError('CONFIG_NOT_FOUND');
  if (!isGameStatus(config.gameStatus)
    || !isRole(config.teamARole)
    || !isRole(config.teamBRole)
    || (config.logs !== undefined && !Array.isArray(config.logs))) {
    throw new WaitingServiceError('INVALID_GAME_CONFIG');
  }
  return config;
}

function rejectCore(reason: WaitingRejectionReason): never {
  throw new WaitingServiceError(reason);
}

function waitingLog(
  id: string,
  now: number,
  team: 'A' | 'B',
  name: string,
  automatic: boolean,
): WaitingLog {
  const time = new Date(now).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
  });
  return {
    id,
    timestamp: now,
    message: automatic
      ? `Team ${team} ${name} が新幹線移動時間超過のため自動で待機モードに移行しました。`
      : `${time} Team ${team} ${name} が新幹線待機を開始 (60分)`,
    type: 'SYSTEM',
  };
}

function validateRuntime(runtime: WaitingRuntime, logRequired: boolean): { now: number; logId?: string } {
  const now = runtime.now();
  const logId = logRequired ? runtime.createLogId() : undefined;
  if (!Number.isFinite(now) || now < 0 || (logRequired && (!logId || typeof logId !== 'string'))) {
    throw new WaitingServiceError('PERSISTENCE_ERROR');
  }
  return { now, ...(logId === undefined ? {} : { logId }) };
}

export async function startWaitingForPlayer(
  uid: string,
  store: WaitingStore,
  runtime: WaitingRuntime,
): Promise<StartWaitingResult> {
  if (typeof uid !== 'string' || uid.length === 0) throw new WaitingServiceError('INVALID_ARGUMENT');
  const { now, logId } = validateRuntime(runtime, true);

  try {
    return await store.runTransaction(async transaction => {
      const [playerDocument, rawConfig] = await Promise.all([
        transaction.readPlayer(uid),
        transaction.readGameConfig(),
      ]);
      const player = readPlayer(playerDocument, uid);
      const config = readConfig(rawConfig);
      const team = player.team as 'A' | 'B';
      const role = getTeamRole(team, {
        teamARole: config.teamARole as Role,
        teamBRole: config.teamBRole as Role,
      });
      const result = startManualWaiting({
        status: player.status as string,
        waitingUntil: player.waitingUntil,
        shinkansenStartTime: player.shinkansenStartTime,
        role,
        phase: config.gameStatus as GameStatus,
        now,
      });
      if (!result.allowed) rejectCore(result.reason);
      if (result.action !== 'MANUAL' || !logId) {
        throw new WaitingServiceError('PERSISTENCE_ERROR');
      }

      const log = waitingLog(logId, now, team, player.name as string, false);
      const logs = [log, ...((config.logs ?? []) as unknown[])].slice(0, 200);
      transaction.writePlayer(uid, {
        status: result.status,
        waitingUntil: result.waitingUntil,
        shinkansenStartTime: result.shinkansenStartTime,
      });
      transaction.writeLogs(logs);
      return { ok: true, waitingUntil: result.waitingUntil, duration: result.duration };
    });
  } catch (error) {
    if (error instanceof WaitingServiceError) throw error;
    throw new WaitingServiceError('PERSISTENCE_ERROR');
  }
}

export async function resumeWaitingForPlayer(
  uid: string,
  store: WaitingStore,
  runtime: WaitingRuntime,
): Promise<ResumeWaitingResult> {
  if (typeof uid !== 'string' || uid.length === 0) throw new WaitingServiceError('INVALID_ARGUMENT');
  const { now } = validateRuntime(runtime, false);

  try {
    return await store.runTransaction(async transaction => {
      const player = readPlayer(await transaction.readPlayer(uid), uid);
      const result = resumeExpiredWaiting({
        status: player.status as string,
        waitingUntil: player.waitingUntil,
        shinkansenStartTime: player.shinkansenStartTime,
        now,
      });
      if (!result.allowed) rejectCore(result.reason);
      if (!result.changed) return { ok: true, resumed: false };

      transaction.writePlayer(uid, {
        status: result.status,
        waitingUntil: result.waitingUntil,
        shinkansenStartTime: result.shinkansenStartTime,
      });
      return { ok: true, resumed: true };
    });
  } catch (error) {
    if (error instanceof WaitingServiceError) throw error;
    throw new WaitingServiceError('PERSISTENCE_ERROR');
  }
}

async function processWaitingLifecycleAt(
  uid: string,
  store: WaitingStore,
  now: number,
  logId: string,
): Promise<ScheduledWaitingResult> {
  try {
    return await store.runTransaction(async transaction => {
      const player = readPlayer(await transaction.readPlayer(uid), uid);
      if (player.status === 'WAITING') {
        const result = resumeExpiredWaiting({
          status: player.status,
          waitingUntil: player.waitingUntil,
          shinkansenStartTime: player.shinkansenStartTime,
          now,
        });
        if (!result.allowed) return { outcome: 'SKIPPED', reason: result.reason };
        if (!result.changed) return { outcome: 'SKIPPED', reason: 'NOT_EXPIRED' };
        transaction.writePlayer(uid, {
          status: result.status,
          waitingUntil: result.waitingUntil,
          shinkansenStartTime: result.shinkansenStartTime,
        });
        return { outcome: 'RESUMED' };
      }

      if (player.status !== 'ACTIVE') return { outcome: 'SKIPPED', reason: 'NOT_ACTIVE' };
      if (player.shinkansenStartTime === undefined
        || player.shinkansenStartTime === null
        || player.shinkansenStartTime === 0) {
        return { outcome: 'SKIPPED', reason: 'NO_SHINKANSEN_START' };
      }

      const config = readConfig(await transaction.readGameConfig());
      const team = player.team as 'A' | 'B';
      const result = startShinkansenLimitWaiting({
        status: player.status,
        waitingUntil: player.waitingUntil,
        shinkansenStartTime: player.shinkansenStartTime,
        phase: config.gameStatus as GameStatus,
        role: getTeamRole(team, {
          teamARole: config.teamARole as Role,
          teamBRole: config.teamBRole as Role,
        }),
        now,
      });
      if (!result.allowed) return { outcome: 'SKIPPED', reason: result.reason };
      if (result.action !== 'SHINKANSEN_LIMIT') {
        throw new WaitingServiceError('PERSISTENCE_ERROR');
      }

      const log = waitingLog(logId, now, team, player.name as string, true);
      const logs = [log, ...((config.logs ?? []) as unknown[])].slice(0, 200);
      transaction.writePlayer(uid, {
        status: result.status,
        waitingUntil: result.waitingUntil,
        shinkansenStartTime: result.shinkansenStartTime,
      });
      transaction.writeLogs(logs);
      return { outcome: 'SHINKANSEN_WAIT_STARTED' };
    });
  } catch (error) {
    if (error instanceof WaitingServiceError) {
      return { outcome: 'SKIPPED', reason: error.reason };
    }
    return { outcome: 'SKIPPED', reason: 'PERSISTENCE_ERROR' };
  }
}

export async function processWaitingLifecycleForPlayer(
  uid: string,
  store: WaitingStore,
  runtime: WaitingRuntime,
): Promise<ScheduledWaitingResult> {
  if (typeof uid !== 'string' || uid.length === 0) return { outcome: 'SKIPPED', reason: 'INVALID_ARGUMENT' };
  try {
    const values = validateRuntime(runtime, true);
    if (!values.logId) return { outcome: 'SKIPPED', reason: 'INVALID_RUNTIME' };
    return await processWaitingLifecycleAt(uid, store, values.now, values.logId);
  } catch {
    return { outcome: 'SKIPPED', reason: 'INVALID_RUNTIME' };
  }
}

export async function processWaitingLifecycle(
  store: WaitingStore,
  runtime: WaitingRuntime,
): Promise<{
  scanned: number;
  resumed: number;
  shinkansenWaiting: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  skippedPlayers: Array<{ uid: string; reason: string }>;
}> {
  const now = runtime.now();
  if (!Number.isFinite(now) || now < 0) throw new WaitingServiceError('PERSISTENCE_ERROR');
  const ids = await store.listParticipantIds();
  let resumed = 0;
  let shinkansenWaiting = 0;
  let skipped = 0;
  const skippedReasons: Record<string, number> = {};
  const skippedPlayers: Array<{ uid: string; reason: string }> = [];

  for (const uid of ids) {
    let result: ScheduledWaitingResult;
    try {
      const logId = runtime.createLogId();
      result = typeof logId === 'string' && logId.length > 0
        ? await processWaitingLifecycleAt(uid, store, now, logId)
        : { outcome: 'SKIPPED', reason: 'INVALID_RUNTIME' };
    } catch {
      result = { outcome: 'SKIPPED', reason: 'INVALID_RUNTIME' };
    }
    if (result.outcome === 'RESUMED') resumed += 1;
    else if (result.outcome === 'SHINKANSEN_WAIT_STARTED') shinkansenWaiting += 1;
    else {
      skipped += 1;
      skippedReasons[result.reason] = (skippedReasons[result.reason] ?? 0) + 1;
      skippedPlayers.push({ uid, reason: result.reason });
    }
  }

  return { scanned: ids.length, resumed, shinkansenWaiting, skipped, skippedReasons, skippedPlayers };
}

