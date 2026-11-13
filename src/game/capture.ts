import { canCapture } from './phases.ts';
import { getPlayerRole } from './roles.ts';
import { CAPTURE_WAIT_DURATION_MS, ONI_INITIAL_LOCK_DURATION_MS, isActiveUntil } from './time.ts';
import type { GameStatus, ProtectionZoneType, Role, TeamRoles, VictoryMode } from './types';

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
  protectionZone?: ProtectionZoneType;
}

export interface CaptureInput {
  captorId: string;
  targetId: string;
  players: readonly CapturePlayer[];
  teamRoles: TeamRoles;
  phase: GameStatus;
  now: number;
  startTime?: number;
  victoryMode?: VictoryMode;
  captureWaitDurationMs?: number;
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
  | 'TARGET_INVINCIBLE'
  | 'ONI_INITIAL_LOCK'
  | 'TARGET_PROTECTION_ZONE';

export interface CapturePlayerChange {
  playerId: string;
  status: 'ACTIVE' | 'WAITING' | 'CAPTURED';
  waitingUntil: number;
  invincibleUntil?: number;
  invincibleCardsDelta: number;
}


export interface CaptureSuccess {
  allowed: true;
  reward: { team: string; scoreDelta: 50 };
  teamRoles: TeamRoles;
  playerChanges: CapturePlayerChange[];
  nextRevealTime?: number;
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

  if (typeof input.startTime === 'number' && input.startTime > 0 && input.now < input.startTime + ONI_INITIAL_LOCK_DURATION_MS) {
    return { allowed: false, reason: 'ONI_INITIAL_LOCK' };
  }

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
  if (target.protectionZone && target.protectionZone !== 'NONE') {
    return { allowed: false, reason: 'TARGET_PROTECTION_ZONE' };
  }

  return { allowed: true, captor, target };
}

export function resolveCapture(input: CaptureInput): CaptureResult {
  const validation = validateCapture(input);
  if (validation.allowed === false) return validation;

  const waitingDuration = typeof input.captureWaitDurationMs === 'number' && input.captureWaitDurationMs > 0
    ? input.captureWaitDurationMs
    : CAPTURE_WAIT_DURATION_MS;
  const waitingUntil = input.now + waitingDuration;

  // サバイバルモード: 確保された逃走者は 'CAPTURED' になり、攻守交代は発生しない
  if (input.victoryMode === 'SURVIVAL') {
    const playerChanges: CapturePlayerChange[] = [
      {
        playerId: validation.target.id,
        status: 'CAPTURED' as const,
        waitingUntil: 0,
        invincibleUntil: 0,
        invincibleCardsDelta: 0,
      },
    ];

    return {
      allowed: true,
      reward: { team: validation.captor.team, scoreDelta: CAPTURE_REWARD_POINTS },
      teamRoles: input.teamRoles,
      playerChanges,
      waitingDuration: 0,
      event: {
        type: 'CAPTURE',
        captorId: input.captorId,
        targetId: input.targetId,
      },
    };
  }

  // 攻守交代モード (SCORE_SWAP または デフォルト)
  const teamARole: Role = input.teamRoles.teamARole === 'ONI' ? 'RUNNER' : 'ONI';
  const teamBRole: Role = teamARole === 'ONI' ? 'RUNNER' : 'ONI';
  const teamRoles: TeamRoles = { teamARole, teamBRole };
  const newOniTeam = teamARole === 'ONI' ? 'A' : 'B';

  const playerChanges = input.players
    .filter(player => (player.team === 'A' || player.team === 'B')
      && player.status !== 'EMERGENCY'
      && player.status !== 'RETIRED')
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
    waitingDuration,
    event: {
      type: 'CAPTURE',
      captorId: input.captorId,
      targetId: input.targetId,
    },
  };
}

