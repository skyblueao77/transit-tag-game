export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface LocationThrottleOptions {
  minIntervalMs?: number;
  maxQuietIntervalMs?: number;
  minDistanceMeters?: number;
  maxAccuracyMeters?: number;
}

export interface ShouldUploadInput {
  currentCoords: Coordinates;
  currentAccuracy?: number;
  currentTimeMs: number;
  lastUploadedCoords: Coordinates | null;
  lastUploadedTimeMs: number;
  options?: LocationThrottleOptions;
}

export type ThrottleDecisionReason =
  | 'INITIAL'
  | 'DISTANCE_EXCEEDED'
  | 'MAX_QUIET_EXCEEDED'
  | 'TOO_FREQUENT'
  | 'ACCURACY_POOR'
  | 'DISTANCE_BELOW_THRESHOLD';

export interface ShouldUploadResult {
  shouldUpload: boolean;
  reason: ThrottleDecisionReason;
  distanceMeters?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_MAX_QUIET_INTERVAL_MS = 300_000; // 5 minutes
const DEFAULT_MIN_DISTANCE_METERS = 30; // 30 meters
const DEFAULT_MAX_ACCURACY_METERS = 400; // 400 meters

/**
 * Computes great-circle distance in meters between two geographic coordinates using the Haversine formula.
 */
export function calculateHaversineDistanceMeters(
  coord1: Coordinates,
  coord2: Coordinates,
): number {
  if (
    coord1.latitude === coord2.latitude &&
    coord1.longitude === coord2.longitude
  ) {
    return 0;
  }

  const R = 6_371_000; // Earth mean radius in meters
  const dLat = ((coord2.latitude - coord1.latitude) * Math.PI) / 180;
  const dLon = ((coord2.longitude - coord1.longitude) * Math.PI) / 180;
  const lat1Rad = (coord1.latitude * Math.PI) / 180;
  const lat2Rad = (coord2.latitude * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Intelligent throttling rule for GPS uploads to conserve Firestore quota on Firebase Spark plan.
 * - Rejects low-accuracy GPS fixes (>400m).
 * - Always uploads initial coordinate.
 * - Disallows uploads within minIntervalMs (1 minute rate limit).
 * - Bypasses distance threshold if maxQuietIntervalMs (5 minutes) has elapsed without an update.
 * - Only uploads if moved >= minDistanceMeters (30m) from previous uploaded position.
 */
export function shouldThrottleLocationUpdate(
  input: ShouldUploadInput,
): ShouldUploadResult {
  const minInterval = input.options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxQuietInterval = input.options?.maxQuietIntervalMs ?? DEFAULT_MAX_QUIET_INTERVAL_MS;
  const minDistance = input.options?.minDistanceMeters ?? DEFAULT_MIN_DISTANCE_METERS;
  const maxAccuracy = input.options?.maxAccuracyMeters ?? DEFAULT_MAX_ACCURACY_METERS;

  // 1. Accuracy check
  if (
    input.currentAccuracy !== undefined &&
    input.currentAccuracy !== null &&
    (!Number.isFinite(input.currentAccuracy) || input.currentAccuracy > maxAccuracy || input.currentAccuracy < 0)
  ) {
    return { shouldUpload: false, reason: 'ACCURACY_POOR' };
  }

  // 2. Initial upload
  if (!input.lastUploadedCoords || input.lastUploadedTimeMs <= 0) {
    return { shouldUpload: true, reason: 'INITIAL', distanceMeters: 0 };
  }

  const elapsed = input.currentTimeMs - input.lastUploadedTimeMs;

  // 3. Minimum interval rate-limiting
  if (elapsed < minInterval) {
    return { shouldUpload: false, reason: 'TOO_FREQUENT' };
  }

  const distance = calculateHaversineDistanceMeters(
    input.lastUploadedCoords,
    input.currentCoords,
  );

  // 4. Maximum quiet interval fallback (keeps participant active even if stationary)
  if (elapsed >= maxQuietInterval) {
    return { shouldUpload: true, reason: 'MAX_QUIET_EXCEEDED', distanceMeters: distance };
  }

  // 5. Distance movement threshold
  if (distance >= minDistance) {
    return { shouldUpload: true, reason: 'DISTANCE_EXCEEDED', distanceMeters: distance };
  }

  return { shouldUpload: false, reason: 'DISTANCE_BELOW_THRESHOLD', distanceMeters: distance };
}

export interface TeammateSplitPlayerInput {
  id: string;
  team: string;
  status: string;
}

export interface TeammateExposedLocationInput {
  latitude: number;
  longitude: number;
  expiresAt: number;
}

export interface TeammateSplitMetrics {
  maxTeammateDistance: number;
  isTeamSplitAlert: boolean;
}

export const TEAM_SPLIT_ALERT_THRESHOLD_METERS = 1500;

export function computeTeammateSplitMetrics(params: {
  currentUserId: string;
  currentUserTeam: string;
  myCoords: Coordinates | null;
  users: readonly TeammateSplitPlayerInput[];
  exposedLocations: Record<string, TeammateExposedLocationInput | undefined>;
  nowMs: number;
  thresholdMeters?: number;
}): TeammateSplitMetrics {
  const {
    currentUserId,
    currentUserTeam,
    myCoords,
    users,
    exposedLocations,
    nowMs,
    thresholdMeters = TEAM_SPLIT_ALERT_THRESHOLD_METERS,
  } = params;

  if (!myCoords || !currentUserTeam) {
    return { maxTeammateDistance: 0, isTeamSplitAlert: false };
  }

  let maxTeammateDistance = 0;
  for (const teammate of users) {
    if (teammate.id === currentUserId || teammate.team !== currentUserTeam || teammate.status !== 'ACTIVE') {
      continue;
    }
    const exp = exposedLocations[teammate.id];
    if (
      exp
      && typeof exp.latitude === 'number'
      && typeof exp.longitude === 'number'
      && exp.expiresAt > nowMs
    ) {
      const dist = calculateHaversineDistanceMeters(myCoords, {
        latitude: exp.latitude,
        longitude: exp.longitude,
      });
      if (dist > maxTeammateDistance) {
        maxTeammateDistance = dist;
      }
    }
  }

  return {
    maxTeammateDistance,
    isTeamSplitAlert: maxTeammateDistance > thresholdMeters,
  };
}

