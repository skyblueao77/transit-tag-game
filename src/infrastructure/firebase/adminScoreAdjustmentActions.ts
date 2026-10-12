import { httpsCallable } from 'firebase/functions';
import type {
  AdjustTeamScoreInput,
  AdjustTeamScoreResult,
  AdminScoreAdjustmentFailureReason,
  AdminScoreAdjustmentGateway,
} from '../../application/gameplayPorts';
import { functions } from './firebaseClient';

const adjustCallable = httpsCallable<AdjustTeamScoreInput, unknown>(functions, 'adjustTeamScore');
const knownReasons = new Set<AdminScoreAdjustmentFailureReason>([
  'UNAUTHENTICATED', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'CONFIG_NOT_FOUND',
  'INVALID_CONFIG', 'SCORE_BELOW_ZERO', 'REQUEST_ID_REUSED', 'PERSISTENCE_ERROR',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failureReason(error: unknown): AdminScoreAdjustmentFailureReason {
  const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
  return typeof details?.reason === 'string' && knownReasons.has(details.reason as AdminScoreAdjustmentFailureReason)
    ? details.reason as AdminScoreAdjustmentFailureReason
    : 'PERSISTENCE_ERROR';
}

function mapResult(value: unknown): AdjustTeamScoreResult {
  if (!isRecord(value)) return { ok: false, reason: 'PERSISTENCE_ERROR' };
  if (value.ok === false && typeof value.reason === 'string' && knownReasons.has(value.reason as AdminScoreAdjustmentFailureReason)) {
    return { ok: false, reason: value.reason as AdminScoreAdjustmentFailureReason };
  }
  if (value.ok === true && (value.team === 'A' || value.team === 'B')
    && Number.isSafeInteger(value.delta) && value.delta !== 0
    && (value.delta as number) >= -1000 && (value.delta as number) <= 1000
    && ['CORRECTION', 'BONUS', 'PENALTY', 'OTHER'].includes(value.reasonCode as string)
    && Number.isSafeInteger(value.previousScore) && (value.previousScore as number) >= 0
    && Number.isSafeInteger(value.nextScore) && (value.nextScore as number) >= 0
    && (value.nextScore as number) === (value.previousScore as number) + (value.delta as number)
    && typeof value.duplicate === 'boolean') {
    return {
      ok: true,
      team: value.team,
      delta: value.delta as number,
      reasonCode: value.reasonCode as AdjustTeamScoreInput['reasonCode'],
      previousScore: value.previousScore as number,
      nextScore: value.nextScore as number,
      duplicate: value.duplicate,
    };
  }
  return { ok: false, reason: 'PERSISTENCE_ERROR' };
}

export const firebaseAdminScoreAdjustmentGateway: AdminScoreAdjustmentGateway = {
  async adjustTeamScore(input) {
    try {
      const response = await adjustCallable({
        team: input.team,
        delta: input.delta,
        reasonCode: input.reasonCode,
        requestId: input.requestId,
      });
      return mapResult(response.data);
    } catch (error) {
      return { ok: false, reason: failureReason(error) };
    }
  },
};
