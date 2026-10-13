import type { EmergencyLocationProjection, ExposedLocation, GameConfig, Mission, PrivateLocation, User } from '../../../types';
import type { GameLog } from '../../../types';
import { isValidGameSessionId, validateGameSession } from '../../game/gameSession.ts';

export function mapUserDocument(id: string, data: Record<string, unknown>): User {
  const user: Record<string, unknown> = { id };
  for (const field of [
    'name', 'role', 'team', 'color', 'score', 'status', 'invincibleUntil',
    'waitingUntil', 'invincibleCards', 'lastStation', 'shinkansenStartTime',
  ]) {
    if (Object.hasOwn(data, field)) user[field] = data[field];
  }
  if (isValidGameSessionId(data.gameSessionId)) user.gameSessionId = data.gameSessionId;
  return user as unknown as User;
}

export function mapPlayerDocuments(
  documents: readonly { id: string; data: Record<string, unknown> }[],
): User[] {
  return documents.map(document => mapUserDocument(document.id, document.data));
}

export function mapMissionDocuments(
  documents: readonly { id: string; data: Record<string, unknown> }[],
): Mission[] {
  return documents.map(({ id, data }) => {
    const mission: Record<string, unknown> = { id };
    for (const field of ['area', 'region', 'title', 'description', 'points', 'lat', 'lng', 'type']) {
      if (Object.hasOwn(data, field)) mission[field] = data[field];
    }
    return mission as unknown as Mission;
  });
}

export function mapPrivateLocation(data: Record<string, unknown> | null): PrivateLocation | null {
  if (!data || !isValidGameSessionId(data.gameSessionId)
    || typeof data.latitude !== 'number' || !Number.isFinite(data.latitude)
    || data.latitude < -90 || data.latitude > 90
    || typeof data.longitude !== 'number' || !Number.isFinite(data.longitude)
    || data.longitude < -180 || data.longitude > 180) return null;
  return {
    gameSessionId: data.gameSessionId,
    latitude: data.latitude,
    longitude: data.longitude,
    ...(data.updatedAt === undefined ? {} : { updatedAt: data.updatedAt }),
  };
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
  expectedSessionId?: string,
): EmergencyLocationProjection | null {
  if (!data || data.playerId !== id || !isValidGameSessionId(data.gameSessionId)
    || (expectedSessionId !== undefined && data.gameSessionId !== expectedSessionId)
    || data.safetyStatus !== 'EMERGENCY'
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
    gameSessionId: data.gameSessionId,
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
  expectedSessionId?: string,
): Record<string, ExposedLocation> {
  const mapped: Record<string, ExposedLocation> = {};
  for (const document of documents) {
    const data = document.data;
    if (!isValidGameSessionId(data.gameSessionId)
      || (expectedSessionId !== undefined && data.gameSessionId !== expectedSessionId)
      || typeof data.latitude !== 'number' || !Number.isFinite(data.latitude)
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
      gameSessionId: data.gameSessionId,
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
  const config: GameConfig = {
    ...defaults,
    logs: Array.isArray(data.logs) ? data.logs as GameLog[] : [],
  };
  if (typeof data.currentArea === 'string') config.currentArea = data.currentArea;
  if (typeof data.currentRegion === 'string') config.currentRegion = data.currentRegion;
  if (typeof data.announcement === 'string') config.announcement = data.announcement;
  if (typeof data.isGameEnded === 'boolean') config.isGameEnded = data.isGameEnded;
  if (typeof data.isGameOver === 'boolean') config.isGameOver = data.isGameOver;
  if (typeof data.isFinalMissionActive === 'boolean') config.isFinalMissionActive = data.isFinalMissionActive;
  if (typeof data.finalMissionEndTime === 'number' && Number.isFinite(data.finalMissionEndTime)) config.finalMissionEndTime = data.finalMissionEndTime;
  if (typeof data.day === 'number' && Number.isFinite(data.day)) config.day = data.day;
  if (typeof data.goalLat === 'number' && Number.isFinite(data.goalLat)) config.goalLat = data.goalLat;
  if (typeof data.goalLng === 'number' && Number.isFinite(data.goalLng)) config.goalLng = data.goalLng;
  if (typeof data.startTime === 'number' && Number.isFinite(data.startTime)) config.startTime = data.startTime;
  if (typeof data.gameStatus === 'string') config.gameStatus = data.gameStatus as GameConfig['gameStatus'];
  if (typeof data.broadcastMessage === 'string') config.broadcastMessage = data.broadcastMessage;
  if (typeof data.broadcastTime === 'number' && Number.isFinite(data.broadcastTime)) config.broadcastTime = data.broadcastTime;
  if (data.missionMode === 'SAME' || data.missionMode === 'DIFFERENT') config.missionMode = data.missionMode;
  for (const field of ['activeMissionA', 'activeMissionB', 'activeFinalMissionId'] as const) {
    const value = data[field];
    if (value === null || typeof value === 'string') config[field] = value as string | null;
  }
  if (typeof data.teamAScore === 'number' && Number.isFinite(data.teamAScore)) config.teamAScore = data.teamAScore;
  if (typeof data.teamBScore === 'number' && Number.isFinite(data.teamBScore)) config.teamBScore = data.teamBScore;
  if (data.teamARole === 'ONI' || data.teamARole === 'RUNNER') config.teamARole = data.teamARole;
  if (data.teamBRole === 'ONI' || data.teamBRole === 'RUNNER') config.teamBRole = data.teamBRole;
  if (typeof data.nextRevealTime === 'number' && Number.isFinite(data.nextRevealTime)) config.nextRevealTime = data.nextRevealTime;
  for (const field of ['locationRevealUntil', 'teamARevealUntil', 'teamBRevealUntil'] as const) {
    const value = data[field];
    if (value === undefined) continue;
    const timestamp = firestoreTimestampMillis(value);
    config[field] = timestamp ?? (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  }
  const session = validateGameSession({
    ...data,
    sessionStartedAt: firestoreTimestampMillis(data.sessionStartedAt) ?? data.sessionStartedAt,
  });
  if (session.valid) {
    config.gameSessionId = session.session.gameSessionId;
    config.sessionStartedAt = session.session.sessionStartedAt;
    config.sessionSchemaVersion = session.session.sessionSchemaVersion;
  } else {
    delete config.gameSessionId;
    delete config.sessionStartedAt;
    delete config.sessionSchemaVersion;
  }
  return config;
}
