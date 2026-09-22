import { canCapture } from './phases.ts';
import { getPlayerRole } from './roles.ts';
import { CAPTURE_WAIT_DURATION_MS, isActiveUntil } from './time.ts';
import type { GameStatus, Role, TeamRoles } from './types';

export type CapturePlayerStatus =
  | 'ACTIVE'
  | 'CAPTURED'
  | 'WAITING'
  | 'EMERGENCY'
  | 'RETIRED';

export interface CapturePlayer {
  id: string;
  team: string;
  status: CapturePlayerStatus;
  invincibleUntil?: number;
  invincibleCards: number;
}

export interface CaptureInput {
  captorId: string;
  targetId: string;
  players: readonly CapturePlayer[];
  teamRoles: TeamRoles;
  phase: GameStatus;
  now: number;
}

export type CaptureRejectionReason =
  | 'PHASE'
  | 'CAPTOR_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'SAME_PLAYER'
  | 'SAME_TEAM'
  | 'CAPTOR_ROLE'
  | 'TARGET_ROLE'
  | 'CAPTOR_STATUS'
  | 'TARGET_STATUS'
  | 'TARGET_INVINCIBLE';

export interface CapturePlayerChange {
  playerId: string;
  status: 'ACTIVE' | 'WAITING';
  waitingUntil: number;
  invincibleUntil?: number;
  invincibleCardsDelta: number;
}

export interface CaptureSuccess {
  allowed: true;
  reward: { team: string; scoreDelta: 50 };
  teamRoles: TeamRoles;
  playerChanges: CapturePlayerChange[];
  nextRevealTime: number;
  waitingDuration: number;
  event: { type: 'CAPTURE'; captorId: string; targetId: string };
}

export interface CaptureFailure {
  allowed: false;
  reason: CaptureRejectionReason;
}

export type CaptureResult = CaptureSuccess | CaptureFailure;

export const CAPTURE_REWARD_POINTS = 50;

export function validateCapture(
  input: CaptureInput,
): CaptureFailure | { allowed: true; captor: CapturePlayer; target: CapturePlayer } {
  if (!canCapture(input.phase)) return { allowed: false, reason: 'PHASE' };

  const captor = input.players.find(player => player.id === input.captorId);
  if (!captor) return { allowed: false, reason: 'CAPTOR_NOT_FOUND' };

  const target = input.players.find(player => player.id === input.targetId);
  if (!target) return { allowed: false, reason: 'TARGET_NOT_FOUND' };

  if (input.captorId === input.targetId) return { allowed: false, reason: 'SAME_PLAYER' };
  if (captor.team === target.team) return { allowed: false, reason: 'SAME_TEAM' };
  if (getPlayerRole(captor, input.teamRoles) !== 'ONI') {
    return { allowed: false, reason: 'CAPTOR_ROLE' };
  }
  if (getPlayerRole(target, input.teamRoles) !== 'RUNNER') {
    return { allowed: false, reason: 'TARGET_ROLE' };
  }
  if (captor.status !== 'ACTIVE') return { allowed: false, reason: 'CAPTOR_STATUS' };
  if (target.status !== 'ACTIVE') return { allowed: false, reason: 'TARGET_STATUS' };
  if (isActiveUntil(target.invincibleUntil, input.now)) {
    return { allowed: false, reason: 'TARGET_INVINCIBLE' };
  }

  return { allowed: true, captor, target };
}

export function resolveCapture(input: CaptureInput): CaptureResult {
  const validation = validateCapture(input);
  if (validation.allowed === false) return validation;

  const teamARole: Role = input.teamRoles.teamARole === 'ONI' ? 'RUNNER' : 'ONI';
  const teamBRole: Role = teamARole === 'ONI' ? 'RUNNER' : 'ONI';
  const teamRoles: TeamRoles = { teamARole, teamBRole };
  const newOniTeam = teamARole === 'ONI' ? 'A' : 'B';
  const waitingUntil = input.now + CAPTURE_WAIT_DURATION_MS;

  const playerChanges = input.players
    .filter(player => player.team === 'A' || player.team === 'B')
    .map(player => {
      if (player.team === newOniTeam) {
        return {
          playerId: player.id,
          status: 'WAITING' as const,
          waitingUntil,
          invincibleUntil: 0,
          invincibleCardsDelta: 0,
        };
      }

      return {
        playerId: player.id,
        status: 'ACTIVE' as const,
        waitingUntil: 0,
        invincibleCardsDelta: 1,
      };
    });

  return {
    allowed: true,
    reward: { team: validation.captor.team, scoreDelta: CAPTURE_REWARD_POINTS },
    teamRoles,
    playerChanges,
    nextRevealTime: waitingUntil,
    waitingDuration: CAPTURE_WAIT_DURATION_MS,
    event: {
      type: 'CAPTURE',
      captorId: input.captorId,
      targetId: input.targetId,
    },
  };
}
