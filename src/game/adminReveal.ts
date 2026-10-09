import { EMERGENCY_LOCATION_FRESHNESS_MS } from './emergencyLocationProjection.ts';

export type AdminRevealScope = 'GLOBAL' | 'TEAM_A' | 'TEAM_B';
export type AdminRevealSnapshotScope = AdminRevealScope;
export type AdminRevealConfigField = 'locationRevealUntil' | 'teamARevealUntil' | 'teamBRevealUntil';

export interface AdminRevealPlayer {
  id: string;
  team: string;
  status: string;
}

export interface AdminRevealLocation {
  id: string;
  latitude: unknown;
  longitude: unknown;
  updatedAt: unknown;
}

export interface AdminRevealSnapshot {
  playerId: string;
  latitude: number;
  longitude: number;
  capturedAt: number;
  expiresAt: number;
  revealScope: AdminRevealScope;
}

export type AdminRevealSkipReason =
  | 'SAFETY_STATUS'
  | 'MISSING_LOCATION'
  | 'INVALID_LOCATION_ID'
  | 'INVALID_COORDINATES'
  | 'INVALID_TIMESTAMP'
  | 'FUTURE_TIMESTAMP'
  | 'STALE_LOCATION';

export interface AdminRevealInput {
  scope: unknown;
  durationMinutes: unknown;
  roster: readonly AdminRevealPlayer[];
  locations: readonly AdminRevealLocation[];
  now: number;
}

export type AdminRevealPlan =
  | {
      allowed: true;
      scope: AdminRevealScope;
      audience: 'AUTHENTICATED_PARTICIPANTS_AND_ADMIN';
      durationMilliseconds: number;
      expiresAt: number;
      configField: AdminRevealConfigField;
      targetPlayerIds: string[];
      snapshots: AdminRevealSnapshot[];
      skipped: { playerId: string; reason: AdminRevealSkipReason }[];
    }
  | {
      allowed: false;
      reason: 'INVALID_SCOPE' | 'INVALID_DURATION' | 'INVALID_TIME' | 'INVALID_ROSTER' | 'ZERO_VALID_LOCATIONS';
    };

export const MIN_ADMIN_REVEAL_DURATION_MINUTES = 1;
export const MAX_ADMIN_REVEAL_DURATION_MINUTES = 30;
export const ADMIN_REVEAL_DURATION_MINUTE_MS = 60 * 1000;

const KNOWN_STATUSES = ['ACTIVE', 'WAITING', 'CAPTURED', 'EMERGENCY', 'RETIRED'] as const;
const SAFETY_STATUSES = new Set(['EMERGENCY', 'RETIRED']);

function isScope(value: unknown): value is AdminRevealScope {
  return value === 'GLOBAL' || value === 'TEAM_A' || value === 'TEAM_B';
}

function configFieldForScope(scope: AdminRevealScope): AdminRevealConfigField {
  if (scope === 'GLOBAL') return 'locationRevealUntil';
  return scope === 'TEAM_A' ? 'teamARevealUntil' : 'teamBRevealUntil';
}

function validateRoster(roster: readonly AdminRevealPlayer[]): boolean {
  if (!Array.isArray(roster)) return false;
  const ids = new Set<string>();
  for (const player of roster) {
    if (!player || typeof player.id !== 'string' || player.id.trim().length === 0
      || typeof player.team !== 'string' || player.team.trim().length === 0
      || typeof player.status !== 'string'
      || !KNOWN_STATUSES.includes(player.status as typeof KNOWN_STATUSES[number])
      || ids.has(player.id)) return false;
    ids.add(player.id);
  }
  return true;
}

function isValidCoordinatePair(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

export function resolveAdminRevealPlan(input: AdminRevealInput): AdminRevealPlan {
  if (!input || typeof input !== 'object') return { allowed: false, reason: 'INVALID_ROSTER' };
  if (!isScope(input.scope)) return { allowed: false, reason: 'INVALID_SCOPE' };
  if (typeof input.durationMinutes !== 'number'
    || !Number.isInteger(input.durationMinutes)
    || input.durationMinutes < MIN_ADMIN_REVEAL_DURATION_MINUTES
    || input.durationMinutes > MAX_ADMIN_REVEAL_DURATION_MINUTES) {
    return { allowed: false, reason: 'INVALID_DURATION' };
  }
  if (!Number.isFinite(input.now) || input.now < 0) return { allowed: false, reason: 'INVALID_TIME' };
  if (!validateRoster(input.roster) || !Array.isArray(input.locations)) {
    return { allowed: false, reason: 'INVALID_ROSTER' };
  }

  const durationMilliseconds = input.durationMinutes * ADMIN_REVEAL_DURATION_MINUTE_MS;
  const expiresAt = input.now + durationMilliseconds;
  if (!Number.isFinite(expiresAt)) return { allowed: false, reason: 'INVALID_TIME' };

  const targetPlayers = input.roster.filter(player => {
    if (player.team !== 'A' && player.team !== 'B') return false;
    if (input.scope === 'TEAM_A') return player.team === 'A';
    if (input.scope === 'TEAM_B') return player.team === 'B';
    return true;
  });
  const locationByPlayer = new Map<string, AdminRevealLocation>();
  for (const location of input.locations) {
    if (!location || typeof location.id !== 'string' || locationByPlayer.has(location.id)) {
      return { allowed: false, reason: 'INVALID_ROSTER' };
    }
    locationByPlayer.set(location.id, location);
  }

  const snapshots: AdminRevealSnapshot[] = [];
  const skipped: { playerId: string; reason: AdminRevealSkipReason }[] = [];
  for (const player of targetPlayers) {
    if (SAFETY_STATUSES.has(player.status)) {
      skipped.push({ playerId: player.id, reason: 'SAFETY_STATUS' });
      continue;
    }
    const location = locationByPlayer.get(player.id);
    if (!location) {
      skipped.push({ playerId: player.id, reason: 'MISSING_LOCATION' });
      continue;
    }
    if (location.id !== player.id) {
      skipped.push({ playerId: player.id, reason: 'INVALID_LOCATION_ID' });
      continue;
    }
    if (!isValidCoordinatePair(location.latitude, location.longitude)) {
      skipped.push({ playerId: player.id, reason: 'INVALID_COORDINATES' });
      continue;
    }
    if (typeof location.updatedAt !== 'number' || !Number.isFinite(location.updatedAt) || location.updatedAt < 0) {
      skipped.push({ playerId: player.id, reason: 'INVALID_TIMESTAMP' });
      continue;
    }
    if (location.updatedAt > input.now) {
      skipped.push({ playerId: player.id, reason: 'FUTURE_TIMESTAMP' });
      continue;
    }
    if (input.now - location.updatedAt >= EMERGENCY_LOCATION_FRESHNESS_MS) {
      skipped.push({ playerId: player.id, reason: 'STALE_LOCATION' });
      continue;
    }
    snapshots.push({
      playerId: player.id,
      latitude: location.latitude as number,
      longitude: location.longitude as number,
      capturedAt: input.now,
      expiresAt,
      revealScope: input.scope,
    });
  }

  if (snapshots.length === 0) return { allowed: false, reason: 'ZERO_VALID_LOCATIONS' };
  return {
    allowed: true,
    scope: input.scope,
    audience: 'AUTHENTICATED_PARTICIPANTS_AND_ADMIN',
    durationMilliseconds,
    expiresAt,
    configField: configFieldForScope(input.scope),
    targetPlayerIds: targetPlayers.map(player => player.id),
    snapshots,
    skipped,
  };
}
