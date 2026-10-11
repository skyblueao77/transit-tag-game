import type { Mission } from '../../types';

export type MissionMode = 'SAME' | 'DIFFERENT';
export type MissionAdminPhase =
  | 'PRE_GAME'
  | 'DAY1_ACTIVE'
  | 'DAY1_PAUSED'
  | 'DAY1_ENDED'
  | 'DAY2_ACTIVE'
  | 'DAY2_PAUSED';
export type MissionAssignmentTarget = 'TEAM_A' | 'TEAM_B' | 'BOTH';
export type MissionAssignmentStrategy = 'MANUAL' | 'RANDOM';

export type MissionAdminRejectionReason =
  | 'INVALID_MODE'
  | 'INVALID_PHASE'
  | 'ASSIGNMENT_NOT_ALLOWED'
  | 'INVALID_STRATEGY'
  | 'INVALID_TARGET'
  | 'INVALID_MISSION'
  | 'INVALID_CATALOG'
  | 'INVALID_RANDOM';

export type MissionModeChangeDecision =
  | { allowed: true; mode: MissionMode; changed: boolean }
  | { allowed: false; reason: 'INVALID_MODE' };

export type MissionAssignmentDecision =
  | {
      allowed: true;
      strategy: MissionAssignmentStrategy;
      target: MissionAssignmentTarget;
      activeMissionA?: string;
      activeMissionB?: string;
      selectedMissionIds: string[];
    }
  | { allowed: false; reason: MissionAdminRejectionReason };

export interface MissionCatalogSyncPlan {
  allowed: boolean;
  reason?: 'INVALID_CATALOG';
  upserts: Mission[];
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  totalManagedCount: number;
}

const allowedPhases = new Set<string>([
  'PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_ACTIVE', 'DAY2_PAUSED',
]);
const validModes = new Set<string>(['SAME', 'DIFFERENT']);
const missionTypes = new Set<string>(['CHECKIN', 'PHOTO']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasCanonicalMissionShape(value: unknown): value is Mission {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const required = ['area', 'description', 'id', 'points', 'region', 'title', 'type'];
  const optional = ['lat', 'lng'];
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  if (keys.some(key => !required.includes(key) && !optional.includes(key))) return false;
  if (typeof value.id !== 'string' || value.id.length === 0
    || typeof value.area !== 'string' || typeof value.region !== 'string'
    || typeof value.title !== 'string' || value.title.trim().length === 0
    || typeof value.description !== 'string'
    || typeof value.points !== 'number' || !Number.isFinite(value.points) || value.points < 0
    || typeof value.type !== 'string' || !missionTypes.has(value.type)) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'lat') && (typeof value.lat !== 'number' || !Number.isFinite(value.lat))) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'lng') && (typeof value.lng !== 'number' || !Number.isFinite(value.lng))) return false;
  return true;
}

function catalogIsValid(catalog: readonly Mission[]): boolean {
  if (!Array.isArray(catalog) || catalog.length === 0) return false;
  const ids = new Set<string>();
  for (const mission of catalog) {
    if (!hasCanonicalMissionShape(mission) || ids.has(mission.id)) return false;
    ids.add(mission.id);
  }
  return true;
}

function sameCanonicalContent(value: unknown, canonical: Mission): boolean {
  if (!hasCanonicalMissionShape(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(canonical).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return expectedKeys.every(key => (value as unknown as Record<string, unknown>)[key] === (canonical as unknown as Record<string, unknown>)[key]);
}

/** Accepts only an exact stored representation of a canonical mission. */
export function validateCanonicalMission(persisted: unknown, canonical: Mission): boolean {
  return hasCanonicalMissionShape(canonical) && sameCanonicalContent(persisted, canonical);
}

export function resolveMissionModeChange(currentMode: unknown, requestedMode: unknown): MissionModeChangeDecision {
  if (typeof requestedMode !== 'string' || !validModes.has(requestedMode)) {
    return { allowed: false, reason: 'INVALID_MODE' };
  }
  if (currentMode !== undefined && currentMode !== null && (typeof currentMode !== 'string' || !validModes.has(currentMode))) {
    return { allowed: false, reason: 'INVALID_MODE' };
  }
  const mode = requestedMode as MissionMode;
  return { allowed: true, mode, changed: currentMode !== mode };
}

function indexFromRandom(value: number, count: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value >= 1 || count <= 0) return null;
  return Math.floor(value * count);
}

export function resolveMissionAssignment(input: {
  phase: unknown;
  currentMode: unknown;
  catalog: readonly Mission[];
  persistedMissions?: Readonly<Record<string, unknown>>;
  strategy: unknown;
  target: unknown;
  missionId?: unknown;
  randomValues?: readonly number[];
}): MissionAssignmentDecision {
  if (typeof input.phase !== 'string' || !allowedPhases.has(input.phase)) {
    return { allowed: false, reason: input.phase === 'FINAL_MISSION' || input.phase === 'GAME_OVER' ? 'ASSIGNMENT_NOT_ALLOWED' : 'INVALID_PHASE' };
  }
  if (!catalogIsValid(input.catalog)) return { allowed: false, reason: 'INVALID_CATALOG' };
  if (input.strategy !== 'MANUAL' && input.strategy !== 'RANDOM') return { allowed: false, reason: 'INVALID_STRATEGY' };

  const byId = new Map(input.catalog.map(mission => [mission.id, mission]));
  if (input.strategy === 'MANUAL') {
    if (input.target !== 'TEAM_A' && input.target !== 'TEAM_B') return { allowed: false, reason: 'INVALID_TARGET' };
    if (typeof input.missionId !== 'string') return { allowed: false, reason: 'INVALID_MISSION' };
    const canonical = byId.get(input.missionId);
    if (!canonical || (input.persistedMissions !== undefined
      && !validateCanonicalMission(input.persistedMissions[input.missionId], canonical))) {
      return { allowed: false, reason: 'INVALID_MISSION' };
    }
    return {
      allowed: true,
      strategy: 'MANUAL',
      target: input.target,
      ...(input.target === 'TEAM_A' ? { activeMissionA: canonical.id } : { activeMissionB: canonical.id }),
      selectedMissionIds: [canonical.id],
    };
  }

  if (input.target !== 'BOTH' || input.missionId !== undefined) return { allowed: false, reason: 'INVALID_TARGET' };
  if (typeof input.currentMode !== 'string' || !validModes.has(input.currentMode)) return { allowed: false, reason: 'INVALID_MODE' };
  const randomValues = input.randomValues;
  if (!randomValues || randomValues.length < (input.currentMode === 'SAME' ? 1 : 2)) {
    return { allowed: false, reason: 'INVALID_RANDOM' };
  }
  const firstIndex = indexFromRandom(randomValues[0], input.catalog.length);
  const secondValue = input.currentMode === 'SAME' ? randomValues[0] : randomValues[1];
  if (firstIndex === null || indexFromRandom(secondValue, input.catalog.length) === null) {
    return { allowed: false, reason: 'INVALID_RANDOM' };
  }
  const first = input.catalog[firstIndex];
  let secondIndex = indexFromRandom(secondValue, input.catalog.length)!;
  if (input.currentMode === 'DIFFERENT' && secondIndex === firstIndex) {
    // Deterministically map the second draw to one of the other canonical entries.
    secondIndex = (firstIndex + 1 + Math.floor(secondValue * (input.catalog.length - 1))) % input.catalog.length;
    if (secondIndex === firstIndex) secondIndex = (firstIndex + 1) % input.catalog.length;
  }
  const second = input.currentMode === 'SAME' ? first : input.catalog[secondIndex];
  if (input.persistedMissions !== undefined
    && (!validateCanonicalMission(input.persistedMissions[first.id], first)
      || !validateCanonicalMission(input.persistedMissions[second.id], second))) {
    return { allowed: false, reason: 'INVALID_MISSION' };
  }
  return {
    allowed: true,
    strategy: 'RANDOM',
    target: 'BOTH',
    activeMissionA: first.id,
    activeMissionB: second.id,
    selectedMissionIds: first.id === second.id ? [first.id] : [first.id, second.id],
  };
}

export function planMissionCatalogSync(
  catalog: readonly Mission[],
  persistedById: Readonly<Record<string, unknown>>,
): MissionCatalogSyncPlan {
  if (!catalogIsValid(catalog) || !isRecord(persistedById)) {
    return { allowed: false, reason: 'INVALID_CATALOG', upserts: [], createdCount: 0, updatedCount: 0, unchangedCount: 0, totalManagedCount: 0 };
  }
  const upserts: Mission[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  for (const mission of catalog) {
    const persisted = Object.prototype.hasOwnProperty.call(persistedById, mission.id) ? persistedById[mission.id] : null;
    if (persisted === null || persisted === undefined) {
      upserts.push({ ...mission });
      createdCount += 1;
    } else if (validateCanonicalMission(persisted, mission)) {
      unchangedCount += 1;
    } else {
      upserts.push({ ...mission });
      updatedCount += 1;
    }
  }
  return { allowed: true, upserts, createdCount, updatedCount, unchangedCount, totalManagedCount: catalog.length };
}
