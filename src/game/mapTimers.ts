import type { GameStatus, Role } from './types';
import { ONI_INITIAL_LOCK_DURATION_MS, remainingSeconds } from './time.ts';
import { isWaitingActive } from './waiting.ts';
import { isGamePaused } from './phases.ts';

export interface MapTimeLeft {
  waiting: number;
  invincible: number;
  nextReveal: number;
  final: number;
  oniLock: number;
  shinkansenRemaining: number;
  forceReveal: number;
  teamSearchRemaining: number;
  penaltyRemaining: number;
}

export interface ComputeMapTimeLeftInput {
  currentUser: {
    team: string;
    status: GameStatus | string;
    waitingUntil?: number;
    invincibleUntil?: number;
    shinkansenStartTime?: number;
    penaltyRevealUntil?: number;
  };
  gameConfig: {
    gameStatus: GameStatus;
    startTime?: number;
    nextRevealTime?: number;
    isFinalMissionActive?: boolean;
    finalMissionEndTime?: number;
    locationRevealUntil?: number | null;
    teamARevealUntil?: number | null;
    teamBRevealUntil?: number | null;
    shinkansenMaxMinutes?: number;
  };
  currentRole: Role;
  now: number;
  defaultShinkansenMaxMinutes?: number;
}

export function computeMapTimeLeft(
  input: ComputeMapTimeLeftInput,
  previous?: MapTimeLeft,
): MapTimeLeft {
  const {
    currentUser,
    gameConfig,
    currentRole,
    now,
    defaultShinkansenMaxMinutes = 150,
  } = input;

  const waiting = isWaitingActive(currentUser.status, currentUser.waitingUntil, now)
    ? remainingSeconds(currentUser.waitingUntil, now)
    : 0;

  const oniLockTime = (gameConfig.startTime || 0) + ONI_INITIAL_LOCK_DURATION_MS;
  const oniLock = currentRole === 'ONI' ? remainingSeconds(oniLockTime, now) : 0;

  if (isGamePaused(gameConfig.gameStatus) && previous) {
    return {
      ...previous,
      waiting,
      oniLock,
    };
  }

  const forceReveal = remainingSeconds(gameConfig.locationRevealUntil ?? undefined, now);
  const myTeamRevealUntil = currentUser.team === 'A'
    ? gameConfig.teamARevealUntil
    : gameConfig.teamBRevealUntil;
  const teamSearchRemaining = remainingSeconds(myTeamRevealUntil ?? undefined, now);
  const invincible = remainingSeconds(currentUser.invincibleUntil, now);
  const final = gameConfig.isFinalMissionActive
    ? remainingSeconds(gameConfig.finalMissionEndTime, now)
    : 0;
  const nextReveal = remainingSeconds(gameConfig.nextRevealTime, now);

  const shinkansenLimitMinutes = gameConfig.shinkansenMaxMinutes ?? defaultShinkansenMaxMinutes;
  let shinkansenRemaining = 0;
  if (currentUser.shinkansenStartTime) {
    if (shinkansenLimitMinutes > 0) {
      const shinkansenUntil = currentUser.shinkansenStartTime + shinkansenLimitMinutes * 60 * 1000;
      shinkansenRemaining = remainingSeconds(shinkansenUntil, now);
    } else {
      shinkansenRemaining = Number.POSITIVE_INFINITY;
    }
  }

  const penaltyRemaining = remainingSeconds(currentUser.penaltyRevealUntil, now);

  return {
    waiting,
    invincible,
    nextReveal,
    final,
    oniLock,
    shinkansenRemaining,
    forceReveal,
    teamSearchRemaining,
    penaltyRemaining,
  };
}
