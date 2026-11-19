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

export const PERIODIC_REVEAL_MIN_INTERVAL_MINUTES = 5;
export const PERIODIC_REVEAL_MAX_INTERVAL_MINUTES = 120;
export const PERIODIC_REVEAL_DEFAULT_INTERVAL_MINUTES = 30;
export const PERIODIC_REVEAL_MIN_DURATION_MINUTES = 1;
export const PERIODIC_REVEAL_MAX_DURATION_MINUTES = 30;
export const PERIODIC_REVEAL_DEFAULT_DURATION_MINUTES = 5;

export interface PeriodicRevealWindowInput {
  phase: GameStatus;
  now: number;
  startTime?: number | null;
  intervalMinutes?: number | null;
  durationMinutes?: number | null;
}

export interface PeriodicRevealWindowResult {
  isActive: boolean;
  activeUntil?: number;
  nextWindowStart?: number;
}

function clampPeriodicInteger(
  value: number | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Deterministically resolves periodic global reveal windows from startTime,
 * intervalMinutes, and durationMinutes without requiring server-side cron writes.
 */
export function resolvePeriodicRevealWindow({
  phase,
  now,
  startTime,
  intervalMinutes,
  durationMinutes,
}: PeriodicRevealWindowInput): PeriodicRevealWindowResult {
  if (!canRevealLocation(phase)) return { isActive: false };
  if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime <= 0 || !Number.isFinite(now)) {
    return { isActive: false };
  }

  const intervalMs = clampPeriodicInteger(
    intervalMinutes,
    PERIODIC_REVEAL_MIN_INTERVAL_MINUTES,
    PERIODIC_REVEAL_MAX_INTERVAL_MINUTES,
    PERIODIC_REVEAL_DEFAULT_INTERVAL_MINUTES,
  ) * 60_000;
  const rawDurationMs = clampPeriodicInteger(
    durationMinutes,
    PERIODIC_REVEAL_MIN_DURATION_MINUTES,
    PERIODIC_REVEAL_MAX_DURATION_MINUTES,
    PERIODIC_REVEAL_DEFAULT_DURATION_MINUTES,
  ) * 60_000;
  const durationMs = Math.min(rawDurationMs, intervalMs);

  const elapsed = now - startTime;
  if (elapsed < intervalMs) {
    return {
      isActive: false,
      nextWindowStart: startTime + intervalMs,
    };
  }

  const cycle = Math.floor(elapsed / intervalMs);
  const windowStart = startTime + cycle * intervalMs;
  const windowEnd = windowStart + durationMs;
  const nextWindowStart = startTime + (cycle + 1) * intervalMs;

  if (now < windowEnd) {
    return {
      isActive: true,
      activeUntil: windowEnd,
      nextWindowStart,
    };
  }

  return {
    isActive: false,
    nextWindowStart,
  };
}

export interface ActiveRevealWindowInput {
  phase: GameStatus;
  locationRevealUntil?: number | null;
  teamARevealUntil?: number | null;
  teamBRevealUntil?: number | null;
  startTime?: number | null;
  periodicRevealIntervalMinutes?: number | null;
  periodicRevealDurationMinutes?: number | null;
  players?: ReadonlyArray<{
    team?: string;
    status?: string;
    penaltyRevealUntil?: number;
  }>;
}

export function hasActiveRevealWindow(input: ActiveRevealWindowInput, now: number): boolean {
  if (!canRevealLocation(input.phase)) return false;
  if (isActiveUntil(input.locationRevealUntil ?? undefined, now)) return true;
  if (isActiveUntil(input.teamARevealUntil ?? undefined, now)) return true;
  if (isActiveUntil(input.teamBRevealUntil ?? undefined, now)) return true;
  if (
    resolvePeriodicRevealWindow({
      phase: input.phase,
      now,
      startTime: input.startTime,
      intervalMinutes: input.periodicRevealIntervalMinutes,
      durationMinutes: input.periodicRevealDurationMinutes,
    }).isActive
  ) {
    return true;
  }
  if (
    input.players?.some(
      player =>
        (player.team === 'A' || player.team === 'B')
        && player.status !== 'EMERGENCY'
        && player.status !== 'RETIRED'
        && isActiveUntil(player.penaltyRevealUntil, now),
    )
  ) {
    return true;
  }
  return false;
}

export interface LocationVisibilityInput {
  viewerId: string;
  player: LocationVisibilityPlayer;
  phase: GameStatus;
  now: number;
  globalRevealUntil?: number;
  teamARevealUntil?: number;
  teamBRevealUntil?: number;
  startTime?: number | null;
  periodicRevealIntervalMinutes?: number | null;
  periodicRevealDurationMinutes?: number | null;
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

  const periodicWindow = resolvePeriodicRevealWindow({
    phase: input.phase,
    now,
    startTime: input.startTime,
    intervalMinutes: input.periodicRevealIntervalMinutes,
    durationMinutes: input.periodicRevealDurationMinutes,
  });
  const effectiveGlobalRevealUntil = periodicWindow.isActive && periodicWindow.activeUntil !== undefined
    ? Math.max(input.globalRevealUntil ?? 0, periodicWindow.activeUntil)
    : input.globalRevealUntil;

  if (isActiveUntil(effectiveGlobalRevealUntil, now)
    && player.exposedLocation?.revealScope === 'GLOBAL') {
    return visibleSnapshot('GLOBAL_SNAPSHOT', player, now, effectiveGlobalRevealUntil);
  }

  const scope = player.exposedLocation?.revealScope;
  if (scope === undefined || scope === 'INDIVIDUAL') {
    return visibleSnapshot('INDIVIDUAL_SNAPSHOT', player, now);
  }

  return { mode: 'HIDDEN' };
}
