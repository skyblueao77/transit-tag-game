export type ScoreAdjustmentTeam = 'A' | 'B';
export type ScoreAdjustmentReasonCode = 'CORRECTION' | 'BONUS' | 'PENALTY' | 'OTHER';
export type ScoreAdjustmentField = 'teamAScore' | 'teamBScore';

export type ScoreAdjustmentRejectionReason =
  | 'INVALID_TEAM'
  | 'INVALID_DELTA'
  | 'INVALID_REASON_CODE'
  | 'INVALID_CURRENT_SCORE'
  | 'SCORE_BELOW_ZERO'
  | 'UNSAFE_RESULT';

export type TeamScoreAdjustmentDecision =
  | {
      allowed: true;
      team: ScoreAdjustmentTeam;
      scoreField: ScoreAdjustmentField;
      previousScore: number;
      delta: number;
      nextScore: number;
      reasonCode: ScoreAdjustmentReasonCode;
    }
  | { allowed: false; reason: ScoreAdjustmentRejectionReason };

const MAX_DELTA = 1_000;
const reasonCodes = new Set<string>(['CORRECTION', 'BONUS', 'PENALTY', 'OTHER']);

/** Resolves an audited Team score delta without mutating its input. */
export function resolveTeamScoreAdjustment(input: {
  team: unknown;
  delta: unknown;
  reasonCode: unknown;
  currentTeamAScore: unknown;
  currentTeamBScore: unknown;
}): TeamScoreAdjustmentDecision {
  if (input.team !== 'A' && input.team !== 'B') return { allowed: false, reason: 'INVALID_TEAM' };
  if (typeof input.delta !== 'number' || !Number.isSafeInteger(input.delta)
    || input.delta === 0 || input.delta < -MAX_DELTA || input.delta > MAX_DELTA) {
    return { allowed: false, reason: 'INVALID_DELTA' };
  }
  if (typeof input.reasonCode !== 'string' || !reasonCodes.has(input.reasonCode)) {
    return { allowed: false, reason: 'INVALID_REASON_CODE' };
  }
  const { currentTeamAScore, currentTeamBScore } = input;
  if (typeof currentTeamAScore !== 'number' || !Number.isSafeInteger(currentTeamAScore) || currentTeamAScore < 0
    || typeof currentTeamBScore !== 'number' || !Number.isSafeInteger(currentTeamBScore) || currentTeamBScore < 0) {
    return { allowed: false, reason: 'INVALID_CURRENT_SCORE' };
  }

  const scoreField: ScoreAdjustmentField = input.team === 'A' ? 'teamAScore' : 'teamBScore';
  const previousScore = input.team === 'A' ? currentTeamAScore : currentTeamBScore;
  const nextScore = previousScore + input.delta;
  if (nextScore < 0) return { allowed: false, reason: 'SCORE_BELOW_ZERO' };
  if (!Number.isSafeInteger(nextScore)) return { allowed: false, reason: 'UNSAFE_RESULT' };

  return {
    allowed: true,
    team: input.team,
    scoreField,
    previousScore,
    delta: input.delta,
    nextScore,
    reasonCode: input.reasonCode as ScoreAdjustmentReasonCode,
  };
}
