import { resolveTeamScoreAdjustment } from '../../../src/game/adminScoreAdjustment';
import type { ScoreAdjustmentReasonCode, ScoreAdjustmentTeam } from '../../../src/game/adminScoreAdjustment';
import { isValidGameSessionId, validateExpectedSession } from '../../../src/game/gameSession';

export type AdminScoreAdjustmentFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'SESSION_CHANGED'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_CONFIG'
  | 'SCORE_BELOW_ZERO'
  | 'REQUEST_ID_REUSED'
  | 'PERSISTENCE_ERROR';

export class AdminScoreAdjustmentServiceError extends Error {
  constructor(readonly reason: AdminScoreAdjustmentFailureReason) {
    super(reason);
    this.name = 'AdminScoreAdjustmentServiceError';
  }
}

export interface TeamScoreAdjustmentResult {
  ok: true;
  team: ScoreAdjustmentTeam;
  delta: number;
  reasonCode: ScoreAdjustmentReasonCode;
  previousScore: number;
  nextScore: number;
  duplicate: boolean;
}

export interface TeamScoreAdjustmentReceipt {
  operation: 'adjustTeamScore';
  requestId: string;
  gameSessionId: string;
  team: ScoreAdjustmentTeam;
  delta: number;
  reasonCode: ScoreAdjustmentReasonCode;
  previousScore: number;
  nextScore: number;
  createdAt: number;
  result: Omit<TeamScoreAdjustmentResult, 'duplicate'> & { duplicate: false };
}

export interface AdminScoreAdjustmentTransaction {
  readAdmin(uid: string): Promise<boolean>;
  readReceipt(uid: string, requestId: string): Promise<Record<string, unknown> | null>;
  readConfig(): Promise<Record<string, unknown> | null>;
  writeAdjustment(
    scoreField: 'teamAScore' | 'teamBScore',
    nextScore: number,
    logs: unknown[],
    uid: string,
    requestId: string,
    receipt: TeamScoreAdjustmentReceipt,
  ): void;
}

export interface AdminScoreAdjustmentStore {
  runTransaction<T>(work: (transaction: AdminScoreAdjustmentTransaction) => Promise<T>): Promise<T>;
}

export interface AdminScoreAdjustmentRuntime {
  now(): number;
  createLogId(): string;
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasonLabels: Record<ScoreAdjustmentReasonCode, string> = {
  CORRECTION: 'スコア訂正',
  BONUS: '運営ボーナス',
  PENALTY: '運営ペナルティ',
  OTHER: 'その他の運営調整',
};

function fail(reason: AdminScoreAdjustmentFailureReason): never {
  throw new AdminScoreAdjustmentServiceError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(value: unknown): {
  team: ScoreAdjustmentTeam;
  delta: number;
  reasonCode: ScoreAdjustmentReasonCode;
  requestId: string;
  expectedSessionId: string;
} {
  if (!isRecord(value) || Object.keys(value).length !== 5
    || !Object.hasOwn(value, 'team') || !Object.hasOwn(value, 'delta')
    || !Object.hasOwn(value, 'reasonCode') || !Object.hasOwn(value, 'requestId')
    || !Object.hasOwn(value, 'expectedSessionId')
    || (value.team !== 'A' && value.team !== 'B')
    || typeof value.delta !== 'number' || !Number.isSafeInteger(value.delta) || value.delta === 0 || value.delta < -1000 || value.delta > 1000
    || typeof value.reasonCode !== 'string' || !Object.hasOwn(reasonLabels, value.reasonCode)
    || typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId)
    || !isValidGameSessionId(value.expectedSessionId)) {
    return fail('INVALID_ARGUMENT');
  }
  return {
    team: value.team,
    delta: value.delta,
    reasonCode: value.reasonCode as ScoreAdjustmentReasonCode,
    requestId: value.requestId,
    expectedSessionId: value.expectedSessionId,
  };
}

function validateRuntime(runtime: AdminScoreAdjustmentRuntime): { now: number; logId: string } {
  const now = runtime.now();
  const logId = runtime.createLogId();
  if (!Number.isFinite(now) || now < 0 || typeof logId !== 'string' || logId.length === 0) fail('PERSISTENCE_ERROR');
  return { now, logId };
}

function readPriorReceipt(
  receipt: Record<string, unknown>,
  request: ReturnType<typeof parseRequest>,
): TeamScoreAdjustmentResult {
  if (receipt.operation !== 'adjustTeamScore' || receipt.requestId !== request.requestId) fail('PERSISTENCE_ERROR');
  if (receipt.gameSessionId !== request.expectedSessionId) fail('REQUEST_ID_REUSED');
  if (receipt.team !== request.team || receipt.delta !== request.delta || receipt.reasonCode !== request.reasonCode) {
    fail('REQUEST_ID_REUSED');
  }
  if (!isRecord(receipt.result) || receipt.result.ok !== true
    || receipt.result.team !== request.team || receipt.result.delta !== request.delta
    || receipt.result.reasonCode !== request.reasonCode || receipt.result.duplicate !== false
    || !Number.isSafeInteger(receipt.result.previousScore) || !Number.isSafeInteger(receipt.result.nextScore)
    || (receipt.result.previousScore as number) < 0 || (receipt.result.nextScore as number) < 0
    || receipt.previousScore !== receipt.result.previousScore || receipt.nextScore !== receipt.result.nextScore
    || !Number.isSafeInteger(receipt.createdAt)
    || (receipt.result.nextScore as number) - (receipt.result.previousScore as number) !== request.delta) {
    fail('PERSISTENCE_ERROR');
  }
  return { ...(receipt.result as Omit<TeamScoreAdjustmentResult, 'duplicate'>), duplicate: true };
}

function logsWithAudit(config: Record<string, unknown>, audit: Record<string, unknown>): unknown[] {
  return [audit, ...((config.logs ?? []) as unknown[])].slice(0, 200);
}

export async function adjustTeamScoreForAdmin(
  authUid: string,
  input: unknown,
  store: AdminScoreAdjustmentStore,
  runtime: AdminScoreAdjustmentRuntime,
): Promise<TeamScoreAdjustmentResult> {
  if (typeof authUid !== 'string' || authUid.length === 0) fail('UNAUTHENTICATED');
  const request = parseRequest(input);
  const { now, logId } = validateRuntime(runtime);

  try {
    return await store.runTransaction(async transaction => {
      if (!await transaction.readAdmin(authUid)) fail('PERMISSION_DENIED');
      const config = await transaction.readConfig();
      if (!config) fail('CONFIG_NOT_FOUND');
      if (!validateExpectedSession(config, request.expectedSessionId).valid) fail('SESSION_CHANGED');
      const prior = await transaction.readReceipt(authUid, request.requestId);
      if (prior) return readPriorReceipt(prior, request);
      if (config.logs !== undefined && !Array.isArray(config.logs)) fail('INVALID_CONFIG');
      const decision = resolveTeamScoreAdjustment({
        team: request.team,
        delta: request.delta,
        reasonCode: request.reasonCode,
        currentTeamAScore: config.teamAScore,
        currentTeamBScore: config.teamBScore,
      });
      if (!decision.allowed) {
        if (decision.reason === 'SCORE_BELOW_ZERO') fail('SCORE_BELOW_ZERO');
        if (decision.reason === 'INVALID_CURRENT_SCORE' || decision.reason === 'UNSAFE_RESULT') fail('INVALID_CONFIG');
        fail('INVALID_ARGUMENT');
      }

      const result: TeamScoreAdjustmentResult = {
        ok: true,
        team: decision.team,
        delta: decision.delta,
        reasonCode: decision.reasonCode,
        previousScore: decision.previousScore,
        nextScore: decision.nextScore,
        duplicate: false,
      };
      const reasonLabel = reasonLabels[decision.reasonCode];
      const audit = {
        id: logId,
        timestamp: now,
        type: 'SYSTEM',
        actorUid: authUid,
        action: 'adjustTeamScore',
        team: decision.team,
        previousScore: decision.previousScore,
        delta: decision.delta,
        nextScore: decision.nextScore,
        reasonCode: decision.reasonCode,
        reasonLabel,
        message: `Team ${decision.team} のスコアを ${decision.previousScore} から ${decision.nextScore} へ補正しました（${reasonLabel}）`,
      };
      const receipt: TeamScoreAdjustmentReceipt = {
        operation: 'adjustTeamScore',
        requestId: request.requestId,
        gameSessionId: request.expectedSessionId,
        team: decision.team,
        delta: decision.delta,
        reasonCode: decision.reasonCode,
        previousScore: decision.previousScore,
        nextScore: decision.nextScore,
        createdAt: now,
        result: { ...result, duplicate: false },
      };
      transaction.writeAdjustment(
        decision.scoreField,
        decision.nextScore,
        logsWithAudit(config, audit),
        authUid,
        request.requestId,
        receipt,
      );
      return result;
    });
  } catch (error) {
    if (error instanceof AdminScoreAdjustmentServiceError) throw error;
    throw new AdminScoreAdjustmentServiceError('PERSISTENCE_ERROR');
  }
}
