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
  const mapped: Record<string, ExposedLocation> = {};
  for (const document of documents) {
    const data = document.data;
    if (typeof data.latitude !== 'number' || !Number.isFinite(data.latitude)
      || data.latitude < -90 || data.latitude > 90
      || typeof data.longitude !== 'number' || !Number.isFinite(data.longitude)
      || data.longitude < -180 || data.longitude > 180
      || (data.playerId !== undefined && data.playerId !== document.id)) continue;
    const capturedAt = firestoreTimestampMillis(data.capturedAt);
    const expiresAt = firestoreTimestampMillis(data.expiresAt);
    if (capturedAt === null || expiresAt === null) continue;
    const revealScope = data.revealScope;
    if (revealScope !== undefined
      && revealScope !== 'GLOBAL' && revealScope !== 'TEAM_A'
      && revealScope !== 'TEAM_B') continue;
    mapped[document.id] = {
      latitude: data.latitude,
      longitude: data.longitude,
      capturedAt,
      expiresAt,
      revealScope: (revealScope ?? 'INDIVIDUAL') as ExposedLocation['revealScope'],
    };
  }
  return mapped;
}

export function mapGameConfigDocument(
  data: Record<string, unknown>,
  defaults: GameConfig,
): GameConfig {
  const config = {
    ...defaults,
    ...data,
    logs: (data.logs as GameLog[] | undefined) ?? [],
  } as GameConfig;
  for (const field of ['locationRevealUntil', 'teamARevealUntil', 'teamBRevealUntil'] as const) {
    const value = data[field];
    if (value === undefined) continue;
    const timestamp = firestoreTimestampMillis(value);
    config[field] = timestamp ?? (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  }
  return config;
}
