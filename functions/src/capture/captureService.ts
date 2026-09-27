import { resolveCapture } from '../../../src/game/capture';
import type {
  CapturePlayer,
  CapturePlayerStatus,
  CaptureRejectionReason,
  CaptureSuccess,
} from '../../../src/game/capture';
import type { GameStatus, Role } from '../../../src/game/types';

export type CaptureFailureReason =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'INVALID_CAPTOR_TEAM'
  | 'INVALID_TARGET_TEAM'
  | 'GAME_CONFIG_NOT_FOUND'
  | 'INVALID_GAME_STATE'
  | 'CAPTURE_REJECTED'
  | 'PERSISTENCE_ERROR';

export class CaptureServiceError extends Error {
  constructor(
    readonly reason: CaptureFailureReason,
    readonly domainReason?: CaptureRejectionReason,
  ) {
    super(reason);
    this.name = 'CaptureServiceError';
  }
}

export interface CaptureUserDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface CaptureLog {
  id: string;
  timestamp: number;
  message: string;
  type: 'CAPTURE';
}

export interface CaptureWrite {
  capture: CaptureSuccess;
  teamScoreField: 'teamAScore' | 'teamBScore';
  logs: unknown[];
}

export interface CaptureTransaction {
  readGameConfig(): Promise<Record<string, unknown> | null>;
  readUsers(captorId: string, targetId: string): Promise<CaptureUserDocument[]>;
  writeCapture(write: CaptureWrite): void;
}

export interface CaptureStore {
  runTransaction<T>(work: (transaction: CaptureTransaction) => Promise<T>): Promise<T>;
}

export interface CaptureRuntime {
  now(): number;
  createLogId(): string;
}

export interface CaptureCompletionResult {
  ok: true;
  capture: CaptureSuccess;
}

const gameStatuses: readonly GameStatus[] = [
  'PRE_GAME',
  'DAY1_ACTIVE',
  'DAY1_PAUSED',
  'DAY1_ENDED',
  'DAY2_ACTIVE',
  'DAY2_PAUSED',
  'FINAL_MISSION',
  'GAME_OVER',
];
const roles: readonly Role[] = ['ONI', 'RUNNER'];
const playerStatuses: readonly CapturePlayerStatus[] = [
  'ACTIVE',
  'CAPTURED',
  'WAITING',
  'EMERGENCY',
  'RETIRED',
];

function isValidTargetId(targetId: unknown): targetId is string {
  return typeof targetId === 'string'
    && targetId.trim().length > 0
    && Buffer.byteLength(targetId, 'utf8') <= 128
    && !targetId.includes('/')
    && !targetId.includes('\0')
    && targetId !== '.'
    && targetId !== '..';
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && roles.includes(value as Role);
}

function isGameStatus(value: unknown): value is GameStatus {
  return typeof value === 'string' && gameStatuses.includes(value as GameStatus);
}

function toCapturePlayer(document: CaptureUserDocument): CapturePlayer {
  const data = document.data;
  if (data.id !== document.id || (data.team !== 'A' && data.team !== 'B')) {
    throw new CaptureServiceError('INVALID_GAME_STATE');
  }
  if (typeof data.status !== 'string' || !playerStatuses.includes(data.status as CapturePlayerStatus)) {
    throw new CaptureServiceError('INVALID_GAME_STATE');
  }
  if (typeof data.invincibleCards !== 'number'
    || !Number.isInteger(data.invincibleCards)
    || data.invincibleCards < 0) {
    throw new CaptureServiceError('INVALID_GAME_STATE');
  }
  if (data.invincibleUntil !== undefined
    && (typeof data.invincibleUntil !== 'number' || !Number.isFinite(data.invincibleUntil))) {
    throw new CaptureServiceError('INVALID_GAME_STATE');
  }

  return {
    id: document.id,
    team: data.team,
    status: data.status as CapturePlayerStatus,
    invincibleCards: data.invincibleCards,
    ...(data.invincibleUntil === undefined ? {} : { invincibleUntil: data.invincibleUntil as number }),
  };
}

function createCaptureLog(
  id: string,
  capture: CaptureSuccess,
  now: number,
): CaptureLog {
  const time = new Date(now).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
  });
  return {
    id,
    timestamp: now,
    message: `${time} Team ${capture.reward.team} が捕獲成功！攻守交代 (+${capture.reward.scoreDelta}pt)`,
    type: 'CAPTURE',
  };
}

export async function capturePlayerForPlayer(
  captorId: string,
  targetId: unknown,
  store: CaptureStore,
  runtime: CaptureRuntime,
): Promise<CaptureCompletionResult> {
  if (!captorId) throw new CaptureServiceError('UNAUTHENTICATED');
  if (!isValidTargetId(targetId)) throw new CaptureServiceError('INVALID_ARGUMENT');

  const now = runtime.now();
  const logId = runtime.createLogId();
  if (!Number.isFinite(now) || !logId) {
    throw new CaptureServiceError('PERSISTENCE_ERROR');
  }

  try {
    return await store.runTransaction(async transaction => {
      const [config, users] = await Promise.all([
        transaction.readGameConfig(),
        transaction.readUsers(captorId, targetId),
      ]);
      if (!config) throw new CaptureServiceError('GAME_CONFIG_NOT_FOUND');

      const usersById = new Map(users.map(user => [user.id, user]));
      const captorDocument = usersById.get(captorId);
      if (!captorDocument) throw new CaptureServiceError('PLAYER_NOT_FOUND');
      if (captorDocument.data.team !== 'A' && captorDocument.data.team !== 'B') {
        throw new CaptureServiceError('INVALID_CAPTOR_TEAM');
      }

      const targetDocument = usersById.get(targetId);
      if (!targetDocument) throw new CaptureServiceError('TARGET_NOT_FOUND');
      if (targetDocument.data.team !== 'A' && targetDocument.data.team !== 'B') {
        throw new CaptureServiceError('INVALID_TARGET_TEAM');
      }

      if (!isGameStatus(config.gameStatus)
        || !isRole(config.teamARole)
        || !isRole(config.teamBRole)
        || typeof config.teamAScore !== 'number'
        || !Number.isFinite(config.teamAScore)
        || typeof config.teamBScore !== 'number'
        || !Number.isFinite(config.teamBScore)
        || (config.logs !== undefined && !Array.isArray(config.logs))) {
        throw new CaptureServiceError('INVALID_GAME_STATE');
      }

      const roster = users
        .filter(user => user.data.team === 'A' || user.data.team === 'B')
        .map(toCapturePlayer);
      const capture = resolveCapture({
        captorId,
        targetId,
        players: roster,
        teamRoles: {
          teamARole: config.teamARole,
          teamBRole: config.teamBRole,
        },
        phase: config.gameStatus,
        now,
      });
      if (capture.allowed === false) {
        throw new CaptureServiceError('CAPTURE_REJECTED', capture.reason);
      }

      const previousLogs = (config.logs ?? []) as unknown[];
      const logs = [createCaptureLog(logId, capture, now), ...previousLogs].slice(0, 200);
      const teamScoreField = capture.reward.team === 'A' ? 'teamAScore' : 'teamBScore';
      transaction.writeCapture({ capture, teamScoreField, logs });

      return { ok: true, capture };
    });
  } catch (error) {
    if (error instanceof CaptureServiceError) throw error;
    throw new CaptureServiceError('PERSISTENCE_ERROR');
  }
}
