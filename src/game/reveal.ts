/** Pure location visibility rules. Coordinates are domain data, not map/UI objects. */
import type { GameStatus } from './types.ts';
import { canRevealLocation } from './phases.ts';
import { isActiveUntil } from './time.ts';

export type LocationVisibilityMode =
  | 'SELF_PRIVATE'
  | 'EMERGENCY_REALTIME'
  | 'TEAM_REALTIME'
  | 'GLOBAL_SNAPSHOT'
  | 'INDIVIDUAL_SNAPSHOT'
  | 'HIDDEN';

export interface LocationVisibilityPlayer {
  id: string;
  team: string;
  status: string;
  privateLatitude?: number | null;
  privateLongitude?: number | null;
  exposedLocation?: {
    latitude: number | null;
    longitude: number | null;
    expiresAt?: number;
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

function hasCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): latitude is number {
  return Number.isFinite(latitude) && Number.isFinite(longitude);
}

function visibleRealtime(
  mode: 'SELF_PRIVATE' | 'EMERGENCY_REALTIME' | 'TEAM_REALTIME',
  player: LocationVisibilityPlayer,
  expiresAt?: number,
): LocationVisibilityResult {
  if (!hasCoordinates(player.privateLatitude, player.privateLongitude)) return { mode: 'HIDDEN' };
  return {
    mode,
    latitude: player.privateLatitude,
    longitude: player.privateLongitude,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function visibleSnapshot(
  mode: 'GLOBAL_SNAPSHOT' | 'INDIVIDUAL_SNAPSHOT',
  player: LocationVisibilityPlayer,
  expiresAt?: number,
): LocationVisibilityResult {
  if (!player.exposedLocation || !hasCoordinates(player.exposedLocation.latitude, player.exposedLocation.longitude)) {
    return { mode: 'HIDDEN' };
  }
  return {
    mode,
    latitude: player.exposedLocation.latitude,
    longitude: player.exposedLocation.longitude,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * Resolves which location, if any, a viewer may use for a player's marker.
 * Self and emergency locations are independent of public reveal phase policy.
 */
export function resolveLocationVisibility(
  input: LocationVisibilityInput,
): LocationVisibilityResult {
  const { player, viewerId, now } = input;

  if (player.id === viewerId) {
    return visibleRealtime('SELF_PRIVATE', player);
  }

  if (player.status === 'EMERGENCY' || player.status === 'RETIRED') {
    return visibleRealtime('EMERGENCY_REALTIME', player);
  }

  if (!canRevealLocation(input.phase)) {
    return { mode: 'HIDDEN' };
  }

  const teamRevealUntil = player.team === 'A'
    ? input.teamARevealUntil
    : player.team === 'B'
      ? input.teamBRevealUntil
      : undefined;

  if (isActiveUntil(teamRevealUntil, now)) {
    return visibleRealtime('TEAM_REALTIME', player, teamRevealUntil);
  }

  if (isActiveUntil(input.globalRevealUntil, now)) {
    return visibleSnapshot('GLOBAL_SNAPSHOT', player, input.globalRevealUntil);
  }

  const individualExpiresAt = player.exposedLocation?.expiresAt;
  if (isActiveUntil(individualExpiresAt, now)) {
    return visibleSnapshot('INDIVIDUAL_SNAPSHOT', player, individualExpiresAt);
  }

  return { mode: 'HIDDEN' };
}
