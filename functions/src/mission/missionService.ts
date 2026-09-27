import { createHash } from 'node:crypto';
import {
  canCompleteMission,
  calculateMissionReward,
} from '../../../src/game/missions';
import { calculateMissionScore } from '../../../src/game/scoring';
import type { GameStatus } from '../../../src/game/types';

export type MissionFailureReason =
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'PLAYER_NOT_ACTIVE'
  | 'INVALID_PLAYER_TEAM'
  | 'MISSION_NOT_FOUND'
  | 'MISSION_NOT_ACTIVE'
  | 'MISSION_NOT_ALLOWED'
  | 'ALREADY_COMPLETED'
  | 'PERSISTENCE_ERROR';

export class MissionServiceError extends Error {
  constructor(readonly reason: MissionFailureReason) {
    super(reason);
    this.name = 'MissionServiceError';
  }
}

export interface MissionCompletionResult {
  ok: true;
  missionId: string;
  reward: ReturnType<typeof calculateMissionReward>;
  score: ReturnType<typeof calculateMissionScore>;
  isFinalMission: boolean;
}

export interface MissionCompletionWrite {
  completionId: string;
  completion: {
    missionId: string;
    team: 'A' | 'B';
    completedBy: string;
    points: number;
    luckyReward: boolean;
    isFinalMission: boolean;
  };
  playerScore: number;
  invincibleCards: number;
  teamScore: number;
  logs: Array<{
    id: string;
    timestamp: number;
    message: string;
    type: 'MISSION';
  }>;
}

export interface MissionTransaction {
  readPlayer(uid: string): Promise<Record<string, unknown> | null>;
  readGameConfig(): Promise<Record<string, unknown> | null>;
  readMission(missionId: string): Promise<Record<string, unknown> | null>;
  readCompletion(completionId: string): Promise<boolean>;
  writeMissionCompletion(write: MissionCompletionWrite): void;
}

export interface MissionStore {
  runTransaction<T>(work: (transaction: MissionTransaction) => Promise<T>): Promise<T>;
}

export interface MissionRuntime {
  random(): number;
  now(): number;
}

export function createMissionCompletionId(team: 'A' | 'B', missionId: string): string {
  const digest = createHash('sha256')
    .update(`${team}\0${missionId}`, 'utf8')
    .digest('hex');
  return `${team}_${digest}`;
}

function isValidMissionId(missionId: unknown): missionId is string {
  return typeof missionId === 'string'
    && missionId.length > 0
    && Buffer.byteLength(missionId, 'utf8') <= 128
    && !missionId.includes('/');
}

function finiteNumberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function createMissionLog(
  completionId: string,
  playerName: string,
  team: 'A' | 'B',
  points: number,
  luckyReward: boolean,
  now: number,
) {
  const time = new Date(now).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
  });
  const buffMessage = luckyReward ? '【LUCKY】無敵カード獲得！' : '';

  return {
    id: completionId,
    timestamp: now,
    message: `${time} Team ${team} ${playerName} がミッション達成 (+${points}pt) ${buffMessage}`.trim(),
    type: 'MISSION' as const,
  };
}

export async function completeMissionForPlayer(
  uid: string,
  missionId: unknown,
  store: MissionStore,
  runtime: MissionRuntime,
): Promise<MissionCompletionResult> {
  if (!isValidMissionId(missionId)) {
    throw new MissionServiceError('INVALID_ARGUMENT');
  }

  // Generate these once per request, outside the retryable transaction callback.
  const randomValue = runtime.random();
  const now = runtime.now();

  try {
    return await store.runTransaction(async transaction => {
      const player = await transaction.readPlayer(uid);
      const config = await transaction.readGameConfig();
      const mission = await transaction.readMission(missionId);

      if (!player) throw new MissionServiceError('PLAYER_NOT_FOUND');
      if (!config) throw new MissionServiceError('MISSION_NOT_ALLOWED');
      if (!mission) throw new MissionServiceError('MISSION_NOT_FOUND');

      const team = player.team;
      if (team !== 'A' && team !== 'B') {
        throw new MissionServiceError('INVALID_PLAYER_TEAM');
      }
      if (player.status !== 'ACTIVE') {
        throw new MissionServiceError('PLAYER_NOT_ACTIVE');
      }

      const gameStatus = config.gameStatus as GameStatus;
      const isFinalMission = gameStatus === 'FINAL_MISSION';
      const completionId = createMissionCompletionId(team, missionId);
      const alreadyCompleted = await transaction.readCompletion(completionId);

      if (alreadyCompleted) throw new MissionServiceError('ALREADY_COMPLETED');
      if (!canCompleteMission(gameStatus, isFinalMission)) {
        throw new MissionServiceError('MISSION_NOT_ALLOWED');
      }

      const activeMissionId = isFinalMission
        ? config.activeFinalMissionId
        : team === 'A' ? config.activeMissionA : config.activeMissionB;
      if (activeMissionId !== missionId) {
        throw new MissionServiceError('MISSION_NOT_ACTIVE');
      }

      if (typeof mission.points !== 'number' || !Number.isFinite(mission.points) || mission.points < 0) {
        throw new MissionServiceError('MISSION_NOT_FOUND');
      }

      const reward = calculateMissionReward(
        { id: missionId, points: mission.points },
        isFinalMission,
      );
      const score = calculateMissionScore(reward, randomValue);
      const playerScore = finiteNumberOrZero(player.score) + score.playerScoreDelta;
      const invincibleCards = finiteNumberOrZero(player.invincibleCards) + score.invincibleCardDelta;
      const teamScoreField = team === 'A' ? 'teamAScore' : 'teamBScore';
      const teamScore = finiteNumberOrZero(config[teamScoreField]) + score.teamScoreDelta;
      const playerName = typeof player.name === 'string' && player.name.length > 0
        ? player.name
        : 'Player';
      const oldLogs = Array.isArray(config.logs) ? config.logs : [];
      const logs = [
        createMissionLog(
          completionId,
          playerName,
          team,
          score.playerScoreDelta,
          score.luckyReward,
          now,
        ),
        ...oldLogs,
      ].slice(0, 200);

      transaction.writeMissionCompletion({
        completionId,
        completion: {
          missionId,
          team,
          completedBy: uid,
          points: score.teamScoreDelta,
          luckyReward: score.luckyReward,
          isFinalMission,
        },
        playerScore,
        invincibleCards,
        teamScore,
        logs,
      });

      return { ok: true, missionId, reward, score, isFinalMission };
    });
  } catch (error) {
    if (error instanceof MissionServiceError) throw error;
    throw new MissionServiceError('PERSISTENCE_ERROR');
  }
}
