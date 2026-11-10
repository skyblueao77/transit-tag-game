/** Pure location visibility rules. Coordinates are domain data, not map/UI objects. */
import type { GameStatus } from './types.ts';
import { canRevealLocation } from './phases.ts';
import { isActiveUntil } from './time.ts';

export type LocationVisibilityMode =
  | 'SELF_PRIVATE'
  | 'TEAM_SNAPSHOT'
  | 'GLOBAL_SNAPSHOT'
  | 'INDIVIDUAL_SNAPSHOT'
  | 'PENALTY_SNAPSHOT'
  | 'HIDDEN';

export interface LocationVisibilityPlayer {
  id: string;
  team: string;
  status: string;
  privateLatitude?: number | null;
  privateLongitude?: number | null;
  penaltyRevealUntil?: number;
  exposedLocation?: {
    latitude: number | null;
    longitude: number | null;
    expiresAt?: number;
    revealScope?: 'GLOBAL' | 'TEAM_A' | 'TEAM_B' | 'INDIVIDUAL' | 'PENALTY';
  };
}

export interface LocationVisibilityInput {
  viewerId: string;
  player: LocationVisibilityPlayer;
  phase: GameStatus;
  now: number;
  globalRevealUntil?: number;
  teamARevealUntil?: number;
  teamBRevealUntil?: number;
}

export interface LocationVisibilityResult {
  mode: LocationVisibilityMode;
  latitude?: number;
  longitude?: number;
  expiresAt?: number;
}

function isCoordinate(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function visibleRealtime(
  mode: 'SELF_PRIVATE',
  player: LocationVisibilityPlayer,
  expiresAt?: number,
): LocationVisibilityResult {
  if (!isCoordinate(player.privateLatitude) || !isCoordinate(player.privateLongitude)) {
    return { mode: 'HIDDEN' };
  }
  return {
    mode,
    latitude: player.privateLatitude,
    longitude: player.privateLongitude,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function visibleSnapshot(
  mode: 'TEAM_SNAPSHOT' | 'GLOBAL_SNAPSHOT' | 'INDIVIDUAL_SNAPSHOT' | 'PENALTY_SNAPSHOT',
  player: LocationVisibilityPlayer,
  now: number,
  deadline?: number,
): LocationVisibilityResult {
  const snapshot = player.exposedLocation;
  if (
    !snapshot ||
    !isCoordinate(snapshot.latitude) ||
    !isCoordinate(snapshot.longitude) ||
    !isActiveUntil(snapshot.expiresAt, now)
  ) {
    return { mode: 'HIDDEN' };
  }
  const expiresAt = deadline === undefined ? snapshot.expiresAt : Math.min(snapshot.expiresAt as number, deadline);
  if (!isActiveUntil(expiresAt, now)) return { mode: 'HIDDEN' };
  return {
    mode,
    latitude: snapshot.latitude,
    longitude: snapshot.longitude,
    expiresAt,
  };
}

/**
 * Resolves which location, if any, a viewer may use for a player's marker.
 * Emergency locations use a separately authorized projection and are never
 * resolved from public player fields here.
 */
export function resolveLocationVisibility(
  input: LocationVisibilityInput,
): LocationVisibilityResult {
  const { player, viewerId, now } = input;

  if (player.id === viewerId) {
    return visibleRealtime('SELF_PRIVATE', player);
  }

  if (player.status === 'EMERGENCY' || player.status === 'RETIRED') {
    return { mode: 'HIDDEN' };
  }

  if (player.team !== 'A' && player.team !== 'B') {
    return { mode: 'HIDDEN' };
  }

  if (!canRevealLocation(input.phase)) {
    return { mode: 'HIDDEN' };
  }

  if (isActiveUntil(player.penaltyRevealUntil, now)
    && (player.exposedLocation?.revealScope === 'PENALTY' || player.exposedLocation?.revealScope === 'INDIVIDUAL' || !player.exposedLocation?.revealScope)) {
    return visibleSnapshot('PENALTY_SNAPSHOT', player, now, player.penaltyRevealUntil);
  }

  const teamRevealUntil = player.team === 'A'
    ? input.teamARevealUntil
    : player.team === 'B'
      ? input.teamBRevealUntil
      : undefined;

  const expectedTeamScope = player.team === 'A' ? 'TEAM_A' : player.team === 'B' ? 'TEAM_B' : undefined;
  if (expectedTeamScope
    && isActiveUntil(teamRevealUntil, now)
    && player.exposedLocation?.revealScope === expectedTeamScope) {
    return visibleSnapshot('TEAM_SNAPSHOT', player, now, teamRevealUntil);
  }

  if (isActiveUntil(input.globalRevealUntil, now)
    && player.exposedLocation?.revealScope === 'GLOBAL') {
    return visibleSnapshot('GLOBAL_SNAPSHOT', player, now, input.globalRevealUntil);
  }

  const scope = player.exposedLocation?.revealScope;
  if (scope === undefined || scope === 'INDIVIDUAL') {
    return visibleSnapshot('INDIVIDUAL_SNAPSHOT', player, now);
  }

  return { mode: 'HIDDEN' };
}
