import type { EmergencyLocationProjection, ExposedLocation, GameConfig, Mission, PrivateLocation, User } from '../../../types';
import type { GameLog } from '../../../types';

export function mapUserDocument(id: string, data: Record<string, unknown>): User {
  return { id, ...data } as User;
}

export function mapPlayerDocuments(
  documents: readonly { id: string; data: Record<string, unknown> }[],
): User[] {
  return documents.map(document => mapUserDocument(document.id, document.data));
}

export function mapMissionDocuments(
  documents: readonly { id: string; data: Record<string, unknown> }[],
): Mission[] {
  return documents.map(document => ({ id: document.id, ...document.data }) as Mission);
}

export function mapPrivateLocation(data: Record<string, unknown> | null): PrivateLocation | null {
  return data ? data as unknown as PrivateLocation : null;
}

function firestoreTimestampMillis(value: unknown): number | null {
  if (!value || typeof value !== 'object' || !('toMillis' in value)
    || typeof value.toMillis !== 'function') return null;
  const millis = value.toMillis();
  return Number.isFinite(millis) ? millis : null;
}

export function mapEmergencyLocationProjection(
  id: string,
  data: Record<string, unknown> | null,
): EmergencyLocationProjection | null {
  if (!data || data.playerId !== id || data.safetyStatus !== 'EMERGENCY'
    || data.projectionKind !== 'EMERGENCY'
    || typeof data.latitude !== 'number' || !Number.isFinite(data.latitude)
    || data.latitude < -90 || data.latitude > 90
    || typeof data.longitude !== 'number' || !Number.isFinite(data.longitude)
    || data.longitude < -180 || data.longitude > 180) return null;

  const projectedAt = firestoreTimestampMillis(data.projectedAt);
  const sourceLocationUpdatedAt = firestoreTimestampMillis(data.sourceLocationUpdatedAt);
  const expiresAt = firestoreTimestampMillis(data.expiresAt);
  if (projectedAt === null || sourceLocationUpdatedAt === null || expiresAt === null
    || sourceLocationUpdatedAt > projectedAt || expiresAt <= projectedAt) return null;

  return {
    playerId: id,
    latitude: data.latitude,
    longitude: data.longitude,
    projectedAt,
    sourceLocationUpdatedAt,
    expiresAt,
    safetyStatus: 'EMERGENCY',
    projectionKind: 'EMERGENCY',
  };
}

export function mapExposedLocationDocuments(
  documents: readonly { id: string; data: Record<string, unknown> }[],
): Record<string, ExposedLocation> {
  return Object.fromEntries(
    documents.map(document => [document.id, document.data as unknown as ExposedLocation]),
  );
}

export function mapGameConfigDocument(
  data: Record<string, unknown>,
  defaults: GameConfig,
): GameConfig {
  return {
    ...defaults,
    ...data,
    logs: (data.logs as GameLog[] | undefined) ?? [],
  } as GameConfig;
}
