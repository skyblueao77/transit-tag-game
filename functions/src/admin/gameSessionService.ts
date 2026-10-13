import {
  GAME_SESSION_SCHEMA_VERSION,
  isValidGameSessionId,
  validateGameSession,
} from '../../../src/game/gameSession';

export type GameSessionInitializationFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_CONFIG'
  | 'SESSION_CHANGED'
  | 'ROSTER_TOO_LARGE'
  | 'PERSISTENCE_ERROR';

export class GameSessionInitializationError extends Error {
  constructor(readonly reason: GameSessionInitializationFailureReason) {
    super(reason);
    this.name = 'GameSessionInitializationError';
  }
}

export interface GameSessionInitializationResult {
  ok: true;
  gameSessionId: string;
  sessionStartedAt: number;
  sessionSchemaVersion: number;
  duplicate: boolean;
  alreadyInitialized: boolean;
}

export interface GameSessionInitializationReceipt {
  operation: 'initializeGameSession';
  requestId: string;
  gameSessionId: string;
  sessionStartedAt: number;
  sessionSchemaVersion: number;
  createdAt: number;
  result: GameSessionInitializationResult;
}

export interface GameSessionInitializationTransaction {
  readAdmin(uid: string): Promise<boolean>;
  readReceipt(uid: string, requestId: string): Promise<Record<string, unknown> | null>;
  readConfig(): Promise<Record<string, unknown> | null>;
  readParticipants(): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  writeInitialization(adminUid: string, input: {
    configPatch?: Record<string, unknown>;
    playerIds: readonly string[];
    receipt: GameSessionInitializationReceipt;
  }): void;
}

export interface GameSessionInitializationStore {
  runTransaction<T>(work: (transaction: GameSessionInitializationTransaction) => Promise<T>): Promise<T>;
}

export interface GameSessionInitializationRuntime {
  now(): number;
  createSessionId(): string;
  createLogId(): string;
}

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const gameStatuses = new Set([
  'PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED',
  'DAY2_ACTIVE', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER',
]);
const roles = new Set(['ONI', 'RUNNER']);
const MAX_TRANSACTION_WRITES = 450;

function fail(reason: GameSessionInitializationFailureReason): never {
  throw new GameSessionInitializationError(reason);
}

function parseRequest(value: unknown): { requestId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1
    || typeof (value as Record<string, unknown>).requestId !== 'string'
    || !requestIdPattern.test((value as Record<string, unknown>).requestId as string)) {
    return fail('INVALID_ARGUMENT');
  }
  return { requestId: (value as { requestId: string }).requestId };
}

function validateLegacyConfig(config: Record<string, unknown> | null): Record<string, unknown> {
  if (!config) return fail('CONFIG_NOT_FOUND');
  if (!gameStatuses.has(config.gameStatus as string)
    || typeof config.teamAScore !== 'number' || !Number.isSafeInteger(config.teamAScore) || config.teamAScore < 0
    || typeof config.teamBScore !== 'number' || !Number.isSafeInteger(config.teamBScore) || config.teamBScore < 0
    || !roles.has(config.teamARole as string) || !roles.has(config.teamBRole as string)
    || config.teamARole === config.teamBRole
    || (config.logs !== undefined && !Array.isArray(config.logs))) {
    return fail('INVALID_CONFIG');
  }
  const anySessionField = ['gameSessionId', 'sessionStartedAt', 'sessionSchemaVersion']
    .some(field => Object.hasOwn(config, field));
  if (anySessionField) {
    const state = validateGameSession(config);
    if (!state.valid) return fail('INVALID_CONFIG');
  }
  return config;
}

function readReceipt(value: Record<string, unknown>, requestId: string): GameSessionInitializationResult {
  const result = value.result;
  if (value.operation !== 'initializeGameSession' || value.requestId !== requestId
    || !isValidGameSessionId(value.gameSessionId)
    || !Number.isSafeInteger(value.sessionStartedAt) || (value.sessionStartedAt as number) < 0
    || !Number.isSafeInteger(value.sessionSchemaVersion)
    || (value.sessionSchemaVersion as number) < GAME_SESSION_SCHEMA_VERSION
    || !result || typeof result !== 'object' || Array.isArray(result)
    || (result as Record<string, unknown>).ok !== true
    || (result as Record<string, unknown>).gameSessionId !== value.gameSessionId
    || (result as Record<string, unknown>).sessionStartedAt !== value.sessionStartedAt
    || (result as Record<string, unknown>).sessionSchemaVersion !== value.sessionSchemaVersion
    || (result as Record<string, unknown>).alreadyInitialized !== true && (result as Record<string, unknown>).alreadyInitialized !== false) {
    return fail('PERSISTENCE_ERROR');
  }
  return { ...(result as GameSessionInitializationResult), duplicate: true };
}

export async function initializeGameSessionForAdmin(
  authUid: string,
  input: unknown,
  store: GameSessionInitializationStore,
  runtime: GameSessionInitializationRuntime,
): Promise<GameSessionInitializationResult> {
  if (typeof authUid !== 'string' || authUid.length === 0) fail('UNAUTHENTICATED');
  const { requestId } = parseRequest(input);
  const now = runtime.now();
  const gameSessionId = runtime.createSessionId();
  const logId = runtime.createLogId();
  if (!Number.isSafeInteger(now) || now < 0 || !isValidGameSessionId(gameSessionId)
    || !isValidGameSessionId(logId) || gameSessionId === logId) fail('PERSISTENCE_ERROR');

  try {
    return await store.runTransaction(async transaction => {
      if (!await transaction.readAdmin(authUid)) fail('PERMISSION_DENIED');
      const priorReceipt = await transaction.readReceipt(authUid, requestId);
      if (priorReceipt) return readReceipt(priorReceipt, requestId);

      const config = validateLegacyConfig(await transaction.readConfig());
      const current = validateGameSession(config);
      if (current.valid) {
        const result: GameSessionInitializationResult = {
          ok: true,
          ...current.session,
          duplicate: true,
          alreadyInitialized: true,
        };
        transaction.writeInitialization(authUid, {
          playerIds: [],
          receipt: {
            operation: 'initializeGameSession',
            requestId,
            ...current.session,
            createdAt: now,
            result,
          },
        });
        return result;
      }

      const participants = await transaction.readParticipants();
      if (participants.length + 2 > MAX_TRANSACTION_WRITES) fail('ROSTER_TOO_LARGE');
      const playerIds: string[] = [];
      const seen = new Set<string>();
      for (const participant of participants) {
        if (participant.id.length === 0 || participant.id.includes('/') || seen.has(participant.id)
          || participant.data.id !== participant.id
          || (participant.data.team !== 'A' && participant.data.team !== 'B')) fail('INVALID_CONFIG');
        seen.add(participant.id);
        playerIds.push(participant.id);
      }

      const session = {
        gameSessionId,
        sessionStartedAt: now,
        sessionSchemaVersion: GAME_SESSION_SCHEMA_VERSION,
      };
      const audit = {
        id: logId,
        timestamp: now,
        type: 'SYSTEM',
        actorUid: authUid,
        action: 'initializeGameSession',
        gameSessionId,
        sessionSchemaVersion: GAME_SESSION_SCHEMA_VERSION,
        message: `Game session initialized (${gameSessionId})`,
      };
      const result: GameSessionInitializationResult = {
        ok: true,
        ...session,
        duplicate: false,
        alreadyInitialized: false,
      };
      transaction.writeInitialization(authUid, {
        configPatch: {
          ...session,
          logs: [audit, ...((config.logs ?? []) as unknown[])].slice(0, 200),
        },
        playerIds,
        receipt: {
          operation: 'initializeGameSession',
          requestId,
          ...session,
          createdAt: now,
          result,
        },
      });
      return result;
    });
  } catch (error) {
    if (error instanceof GameSessionInitializationError) throw error;
    throw new GameSessionInitializationError('PERSISTENCE_ERROR');
  }
}
