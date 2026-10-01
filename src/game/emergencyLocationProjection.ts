export const EMERGENCY_LOCATION_FRESHNESS_MS = 2 * 60 * 1000;

export interface EmergencyLocationProjectionInput {
  status: string;
  latitude: unknown;
  longitude: unknown;
  sourceLocationUpdatedAt: unknown;
  now: number;
}

export type EmergencyLocationProjectionDecision =
  | { kind: 'PROJECT'; expiresAt: number }
  | { kind: 'NOT_REQUIRED' }
  | { kind: 'INVALID_TIME' }
  | { kind: 'INVALID_COORDINATES' }
  | { kind: 'STALE_LOCATION' };

export function resolveEmergencyLocationProjection(
  input: EmergencyLocationProjectionInput,
): EmergencyLocationProjectionDecision {
  if (input.status !== 'EMERGENCY') return { kind: 'NOT_REQUIRED' };
  if (!Number.isFinite(input.now) || input.now < 0
    || typeof input.sourceLocationUpdatedAt !== 'number'
    || !Number.isFinite(input.sourceLocationUpdatedAt)
    || input.sourceLocationUpdatedAt < 0
    || input.sourceLocationUpdatedAt > input.now) {
    return { kind: 'INVALID_TIME' };
  }
  if (typeof input.latitude !== 'number' || !Number.isFinite(input.latitude)
    || input.latitude < -90 || input.latitude > 90
    || typeof input.longitude !== 'number' || !Number.isFinite(input.longitude)
    || input.longitude < -180 || input.longitude > 180) {
    return { kind: 'INVALID_COORDINATES' };
  }

  const expiresAt = input.sourceLocationUpdatedAt + EMERGENCY_LOCATION_FRESHNESS_MS;
  if (input.now >= expiresAt) return { kind: 'STALE_LOCATION' };
  return { kind: 'PROJECT', expiresAt };
}
