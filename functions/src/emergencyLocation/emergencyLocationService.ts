import { resolveEmergencyLocationProjection } from '../../../src/game/emergencyLocationProjection';

export type EmergencyProjectionStatus = 'CREATED' | 'REFRESHED' | 'UNAVAILABLE' | 'STALE' | 'NOT_REQUIRED';

export interface EmergencyProjectionDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface EmergencyProjectionWrite {
  playerId: string;
  latitude: number;
  longitude: number;
  projectedAt: number;
  sourceLocationUpdatedAt: number;
  expiresAt: number;
  safetyStatus: 'EMERGENCY';
  projectionKind: 'EMERGENCY';
}

export interface EmergencyProjectionTransaction {
  readPlayer(uid: string): Promise<EmergencyProjectionDocument | null>;
  readPrivateLocation(uid: string): Promise<EmergencyProjectionDocument | null>;
  readProjection(uid: string): Promise<EmergencyProjectionDocument | null>;
  writeProjection(uid: string, projection: EmergencyProjectionWrite): void;
  deleteProjection(uid: string): void;
}

export interface EmergencyProjectionStore {
  runTransaction<T>(work: (transaction: EmergencyProjectionTransaction) => Promise<T>): Promise<T>;
}

export interface EmergencyProjectionRuntime {
  now(): number;
}

const knownStatuses = ['ACTIVE', 'WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED'] as const;

function timestampMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object'
    && 'toMillis' in value
    && typeof value.toMillis === 'function') {
    const timestamp = value.toMillis();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function removeProjectionIfPresent(
  transaction: EmergencyProjectionTransaction,
  uid: string,
  projection: EmergencyProjectionDocument | null,
): void {
  if (projection) transaction.deleteProjection(uid);
}

export async function projectEmergencyLocationForPlayer(
  uid: string,
  store: EmergencyProjectionStore,
  runtime: EmergencyProjectionRuntime,
): Promise<{ status: EmergencyProjectionStatus }> {
  if (typeof uid !== 'string' || uid.length === 0) return { status: 'UNAVAILABLE' };
  const now = runtime.now();
  if (!Number.isFinite(now) || now < 0) return { status: 'UNAVAILABLE' };

  return store.runTransaction(async transaction => {
    const [playerDocument, locationDocument, existingProjection] = await Promise.all([
      transaction.readPlayer(uid),
      transaction.readPrivateLocation(uid),
      transaction.readProjection(uid),
    ]);

    if (!playerDocument) {
      removeProjectionIfPresent(transaction, uid, existingProjection);
      return { status: 'UNAVAILABLE' };
    }
    const player = playerDocument.data;
    if (playerDocument.id !== uid
      || player.id !== uid
      || typeof player.name !== 'string'
      || player.name.trim().length === 0
      || (player.team !== 'A' && player.team !== 'B')
      || typeof player.status !== 'string'
      || !knownStatuses.includes(player.status as typeof knownStatuses[number])) {
      removeProjectionIfPresent(transaction, uid, existingProjection);
      return { status: 'UNAVAILABLE' };
    }
    if (player.status !== 'EMERGENCY') {
      removeProjectionIfPresent(transaction, uid, existingProjection);
      return { status: 'NOT_REQUIRED' };
    }
    if (!locationDocument || locationDocument.id !== uid) {
      removeProjectionIfPresent(transaction, uid, existingProjection);
      return { status: 'UNAVAILABLE' };
    }

    const location = locationDocument.data;
    const sourceLocationUpdatedAt = timestampMillis(location.updatedAt);
    if (sourceLocationUpdatedAt === null) {
      removeProjectionIfPresent(transaction, uid, existingProjection);
      return { status: 'UNAVAILABLE' };
    }

    const decision = resolveEmergencyLocationProjection({
      status: player.status,
      latitude: location.latitude,
      longitude: location.longitude,
      sourceLocationUpdatedAt,
      now,
    });
    if (decision.kind !== 'PROJECT') {
      removeProjectionIfPresent(transaction, uid, existingProjection);
      return { status: decision.kind === 'STALE_LOCATION' ? 'STALE' : 'UNAVAILABLE' };
    }

    transaction.writeProjection(uid, {
      playerId: uid,
      latitude: location.latitude as number,
      longitude: location.longitude as number,
      projectedAt: now,
      sourceLocationUpdatedAt,
      expiresAt: decision.expiresAt,
      safetyStatus: 'EMERGENCY',
      projectionKind: 'EMERGENCY',
    });
    return { status: existingProjection ? 'REFRESHED' : 'CREATED' };
  });
}
