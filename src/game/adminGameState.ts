import { ONI_INITIAL_LOCK_DURATION_MS } from './time.ts';
import type { Role, TeamRoles } from './types.ts';

export type AdminPlayerStatus = 'ACTIVE' | 'WAITING' | 'EMERGENCY' | 'RETIRED' | 'CAPTURED';

export interface AdminRoleSwapPlayer {
  id: string;
  team: string;
  status: string;
}

export interface AdminRoleSwapInput {
  teamRoles: TeamRoles;
  players: readonly AdminRoleSwapPlayer[];
  now: number;
}

export interface AdminRoleSwapPlayerChange {
  playerId: string;
  status: 'ACTIVE' | 'WAITING';
  waitingUntil: number;
  shinkansenStartTime: null;
  invincibleUntil?: 0;
}

export type AdminRoleSwapRejectionReason =
  | 'INVALID_ROLES'
  | 'INVALID_TIME'
  | 'INVALID_PLAYER'
  | 'DUPLICATE_PLAYER';

export type AdminRoleSwapResult =
  | {
      allowed: true;
      teamRoles: TeamRoles;
      nextRevealTime: number;
      newOniTeam: 'A' | 'B';
      playerChanges: AdminRoleSwapPlayerChange[];
      excludedSafetyPlayerIds: string[];
    }
  | { allowed: false; reason: AdminRoleSwapRejectionReason };

const knownStatuses: readonly AdminPlayerStatus[] = [
  'ACTIVE', 'WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED',
];

function validRoles(value: unknown): value is TeamRoles {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const teamRoles = value as TeamRoles;
  return (teamRoles.teamARole === 'ONI' || teamRoles.teamARole === 'RUNNER')
    && (teamRoles.teamBRole === 'ONI' || teamRoles.teamBRole === 'RUNNER')
    && teamRoles.teamARole !== teamRoles.teamBRole;
}

export function resolveAdminRoleSwap(input: AdminRoleSwapInput): AdminRoleSwapResult {
  if (input === null || typeof input !== 'object') return { allowed: false, reason: 'INVALID_PLAYER' };
  if (!validRoles(input.teamRoles)) return { allowed: false, reason: 'INVALID_ROLES' };
  if (!Number.isFinite(input.now) || input.now < 0) return { allowed: false, reason: 'INVALID_TIME' };
  if (!Array.isArray(input.players)) return { allowed: false, reason: 'INVALID_PLAYER' };

  const ids = new Set<string>();
  for (const player of input.players) {
    if (!player || typeof player.id !== 'string' || player.id.trim().length === 0
      || typeof player.team !== 'string'
      || typeof player.status !== 'string'
      || !knownStatuses.includes(player.status as AdminPlayerStatus)) {
      return { allowed: false, reason: 'INVALID_PLAYER' };
    }
    if (ids.has(player.id)) return { allowed: false, reason: 'DUPLICATE_PLAYER' };
    ids.add(player.id);
  }

  const teamARole: Role = input.teamRoles.teamARole === 'ONI' ? 'RUNNER' : 'ONI';
  const teamBRole: Role = teamARole === 'ONI' ? 'RUNNER' : 'ONI';
  const teamRoles: TeamRoles = { teamARole, teamBRole };
  const newOniTeam: 'A' | 'B' = teamARole === 'ONI' ? 'A' : 'B';
  const waitingUntil = input.now + ONI_INITIAL_LOCK_DURATION_MS;
  if (!Number.isFinite(waitingUntil)) return { allowed: false, reason: 'INVALID_TIME' };

  const excludedSafetyPlayerIds: string[] = [];
  const playerChanges = input.players.flatMap<AdminRoleSwapPlayerChange>(player => {
    if (player.team !== 'A' && player.team !== 'B') return [];
    if (player.status === 'EMERGENCY' || player.status === 'RETIRED') {
      excludedSafetyPlayerIds.push(player.id);
      return [];
    }
    if (player.status !== 'ACTIVE' && player.status !== 'WAITING') return [];

    if (player.team === newOniTeam) {
      return [{
        playerId: player.id,
        status: 'WAITING' as const,
        waitingUntil,
        shinkansenStartTime: null,
        invincibleUntil: 0 as const,
      }];
    }
    return [{
      playerId: player.id,
      status: 'ACTIVE' as const,
      waitingUntil: 0,
      shinkansenStartTime: null,
    }];
  });

  return {
    allowed: true,
    teamRoles,
    nextRevealTime: waitingUntil,
    newOniTeam,
    playerChanges,
    excludedSafetyPlayerIds,
  };
}

export interface AdminPlayerResumeInput {
  status: string;
}

export type AdminPlayerResumeRejectionReason = 'INVALID_STATUS';

export type AdminPlayerResumeResult =
  | {
      allowed: true;
      changed: boolean;
      status: 'ACTIVE';
      waitingUntil: 0;
      shinkansenStartTime: null;
      invincibleUntil?: 0;
    }
  | { allowed: false; reason: AdminPlayerResumeRejectionReason };

export function resolveAdminPlayerResume(input: AdminPlayerResumeInput): AdminPlayerResumeResult {
  if (input === null || typeof input !== 'object'
    || typeof input.status !== 'string'
    || !knownStatuses.includes(input.status as AdminPlayerStatus)) {
    return { allowed: false, reason: 'INVALID_STATUS' };
  }
  if (input.status === 'ACTIVE') {
    return {
      allowed: true,
      changed: false,
      status: 'ACTIVE',
      waitingUntil: 0,
      shinkansenStartTime: null,
    };
  }
  return {
    allowed: true,
    changed: true,
    status: 'ACTIVE',
    waitingUntil: 0,
    shinkansenStartTime: null,
    ...(input.status === 'EMERGENCY' || input.status === 'RETIRED' ? { invincibleUntil: 0 as const } : {}),
  };
}
