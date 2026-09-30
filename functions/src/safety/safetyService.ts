import { resolvePlayerSafetyAction } from '../../../src/game/playerSafety';
import type {
  PlayerSafetyStatus,
  SafetyAction,
  SafetyReasonCode,
  SafetyRejectionReason,
} from '../../../src/game/playerSafety';

export type SafetyFailureReason =
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_PLAYER_STATE'
  | 'INVALID_GAME_CONFIG'
  | 'INVALID_TEAM'
  | 'PERSISTENCE_ERROR'
  | SafetyRejectionReason;

export class SafetyServiceError extends Error {
  constructor(readonly reason: SafetyFailureReason) {
    super(reason);
    this.name = 'SafetyServiceError';
  }
}

export interface SafetyPlayerDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface SafetyPlayerUpdates {
  status: 'EMERGENCY' | 'RETIRED';
  waitingUntil: 0;
  shinkansenStartTime: null;
  invincibleUntil: 0;
}

export interface SafetyLog {
  id: string;
  timestamp: number;
  message: string;
  type: 'EMERGENCY';
}

export interface SafetyTransaction {
  readPlayer(uid: string): Promise<SafetyPlayerDocument | null>;
  readGameConfig(): Promise<Record<string, unknown> | null>;
  writePlayer(uid: string, updates: SafetyPlayerUpdates): void;
  writeLogs(logs: unknown[]): void;
}

export interface SafetyStore {
  runTransaction<T>(work: (transaction: SafetyTransaction) => Promise<T>): Promise<T>;
}

export interface SafetyRuntime {
  now(): number;
  createLogId(): string;
}

export interface SafetyActionSuccess {
  ok: true;
  changed: boolean;
  status: 'EMERGENCY' | 'RETIRED';
}

const statuses: readonly PlayerSafetyStatus[] = [
  'ACTIVE',
  'WAITING',
  'EMERGENCY',
  'RETIRED',
  'CAPTURED',
];

const reasonLabels: Record<SafetyReasonCode, string> = {
  ILLNESS_OR_INJURY: '急病・怪我',
  EQUIPMENT_ISSUE: '機材トラブル',
  OTHER: 'その他の緊急事態',
  RETIREMENT_REQUEST: 'リタイア',
};

function invalidRequest(): never {
  throw new SafetyServiceError('INVALID_ARGUMENT');
}

function parseRequest(data: unknown): { action: SafetyAction; reasonCode: SafetyReasonCode } {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return invalidRequest();
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(record, 'action')
    || !Object.prototype.hasOwnProperty.call(record, 'reasonCode')) {
    return invalidRequest();
  }
  if (typeof record.action !== 'string' || typeof record.reasonCode !== 'string') return invalidRequest();

  if (record.action !== 'EMERGENCY' && record.action !== 'RETIRE') {
    throw new SafetyServiceError('INVALID_ACTION');
  }
  if (!Object.prototype.hasOwnProperty.call(reasonLabels, record.reasonCode)) {
    throw new SafetyServiceError('INVALID_REASON_CODE');
  }
  return {
    action: record.action,
    reasonCode: record.reasonCode as SafetyReasonCode,
  };
}

function isFiniteTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || isFiniteTimestamp(value);
}

function readPlayer(
  document: SafetyPlayerDocument | null,
  uid: string,
): Record<string, unknown> {
  if (!document) throw new SafetyServiceError('PLAYER_NOT_FOUND');
  const player = document.data;
  if (document.id !== uid
    || player.id !== uid
    || typeof player.name !== 'string'
    || player.name.trim().length === 0
    || typeof player.status !== 'string'
    || !statuses.includes(player.status as PlayerSafetyStatus)
    || !isOptionalTimestamp(player.waitingUntil)
    || !isOptionalTimestamp(player.shinkansenStartTime)
    || !isOptionalTimestamp(player.invincibleUntil)
    || !Number.isInteger(player.invincibleCards)
    || (player.invincibleCards as number) < 0
    || typeof player.score !== 'number'
    || !Number.isFinite(player.score)) {
    throw new SafetyServiceError('INVALID_PLAYER_STATE');
  }
  if (player.team !== 'A' && player.team !== 'B') {
    throw new SafetyServiceError('INVALID_TEAM');
  }
  return player;
}

function readConfig(config: Record<string, unknown> | null): Record<string, unknown> {
  if (!config) throw new SafetyServiceError('CONFIG_NOT_FOUND');
  if (config.logs !== undefined && !Array.isArray(config.logs)) {
    throw new SafetyServiceError('INVALID_GAME_CONFIG');
  }
  return config;
}

export async function requestSafetyActionForPlayer(
  uid: string,
  request: unknown,
  store: SafetyStore,
  runtime: SafetyRuntime,
): Promise<SafetyActionSuccess> {
  if (typeof uid !== 'string' || uid.length === 0) throw new SafetyServiceError('INVALID_ARGUMENT');
  const { action, reasonCode } = parseRequest(request);
  const now = runtime.now();
  const logId = runtime.createLogId();
  if (!Number.isFinite(now) || now < 0 || typeof logId !== 'string' || logId.length === 0) {
    throw new SafetyServiceError('PERSISTENCE_ERROR');
  }

  try {
    return await store.runTransaction(async transaction => {
      const [playerDocument, rawConfig] = await Promise.all([
        transaction.readPlayer(uid),
        transaction.readGameConfig(),
      ]);
      const player = readPlayer(playerDocument, uid);
      const config = readConfig(rawConfig);
      const result = resolvePlayerSafetyAction({
        action,
        reasonCode,
        status: player.status,
      });
      if (!result.allowed) throw new SafetyServiceError(result.reason);
      if (!result.changed) {
        return { ok: true, changed: false, status: result.status };
      }

      const log: SafetyLog = {
        id: logId,
        timestamp: now,
        message: `【緊急】Team ${player.team} ${player.name} が SOS を発信: ${reasonLabels[reasonCode]}`,
        type: 'EMERGENCY',
      };
      const logs = [log, ...((config.logs ?? []) as unknown[])].slice(0, 200);
      transaction.writePlayer(uid, {
        status: result.status,
        waitingUntil: result.waitingUntil,
        shinkansenStartTime: result.shinkansenStartTime,
        invincibleUntil: result.invincibleUntil,
      });
      transaction.writeLogs(logs);
      return { ok: true, changed: true, status: result.status };
    });
  } catch (error) {
    if (error instanceof SafetyServiceError) throw error;
    throw new SafetyServiceError('PERSISTENCE_ERROR');
  }
}
