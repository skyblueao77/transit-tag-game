import type { Role, VictoryMode } from './types.ts';

export interface MissionPointsLike {
  points: number;
}

export interface MissionScoreResult {
  teamScoreDelta: number;
  playerScoreDelta: number;
  invincibleCardDelta: number;
  luckyReward: boolean;
}

export const LUCKY_REWARD_THRESHOLD = 0.2;

export function calculateMissionScore(
  mission: MissionPointsLike,
  randomValue: number,
): MissionScoreResult {
  const luckyReward = randomValue >= 0 && randomValue < LUCKY_REWARD_THRESHOLD;

  return {
    teamScoreDelta: mission.points,
    playerScoreDelta: mission.points,
    invincibleCardDelta: luckyReward ? 1 : 0,
    luckyReward,
  };
}

export interface DetermineWinnerInput {
  victoryMode?: VictoryMode;
  teamAScore: number;
  teamBScore: number;
  teamARole: Role;
  teamBRole: Role;
  players: readonly { team: string; status: string; role?: Role }[];
}

export function determineGameWinner(input: DetermineWinnerInput): 'A' | 'B' | 'DRAW' {
  if (input.victoryMode === 'SURVIVAL') {
    const runnerTeam = input.teamARole === 'RUNNER' ? 'A' : 'B';
    const oniTeam = input.teamARole === 'ONI' ? 'A' : 'B';
    const runners = input.players.filter(p => p.team === runnerTeam && p.role !== 'ONI');
    const survivingRunners = runners.filter(
      p => p.status === 'ACTIVE' || p.status === 'WAITING' || p.status === 'EMERGENCY',
    );
    if (runners.length > 0 && survivingRunners.length === 0) {
      return oniTeam;
    }
    return runnerTeam;
  }

  if (input.teamAScore > input.teamBScore) return 'A';
  if (input.teamBScore > input.teamAScore) return 'B';
  return 'DRAW';
}

