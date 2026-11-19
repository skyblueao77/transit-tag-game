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
  const optional = ['lat', 'lng', 'isFinalMission'];
  if (required.some(key => !Object.hasOwn(value, key))) return false;
  if (keys.some(key => !required.includes(key) && !optional.includes(key))) return false;
  if (typeof value.id !== 'string' || value.id.length === 0
    || typeof value.area !== 'string' || typeof value.region !== 'string'
    || typeof value.title !== 'string' || value.title.trim().length === 0
    || typeof value.description !== 'string'
    || typeof value.points !== 'number' || !Number.isFinite(value.points) || value.points < 0
    || typeof value.type !== 'string' || !missionTypes.has(value.type)) return false;
  if (Object.hasOwn(value, 'lat') && (typeof value.lat !== 'number' || !Number.isFinite(value.lat))) return false;
  if (Object.hasOwn(value, 'lng') && (typeof value.lng !== 'number' || !Number.isFinite(value.lng))) return false;
  if (Object.hasOwn(value, 'isFinalMission') && typeof value.isFinalMission !== 'boolean') return false;
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

  const normalCatalog = input.catalog.filter(mission => !mission.isFinalMission && !mission.id.startsWith('final_'));
  if (normalCatalog.length === 0) return { allowed: false, reason: 'INVALID_CATALOG' };

  const byId = new Map(normalCatalog.map(mission => [mission.id, mission]));
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
  const firstIndex = indexFromRandom(randomValues[0], normalCatalog.length);
  const secondValue = input.currentMode === 'SAME' ? randomValues[0] : randomValues[1];
  const secondIndexRaw = indexFromRandom(secondValue, normalCatalog.length);
  if (firstIndex === null || secondIndexRaw === null) {
    return { allowed: false, reason: 'INVALID_RANDOM' };
  }
  const first = normalCatalog[firstIndex];
  let secondIndex = secondIndexRaw;
  if (input.currentMode === 'DIFFERENT' && secondIndex === firstIndex) {
    // Deterministically map the second draw to one of the other canonical entries.
    secondIndex = (firstIndex + 1 + Math.floor(secondValue * (normalCatalog.length - 1))) % normalCatalog.length;
    if (secondIndex === firstIndex) secondIndex = (firstIndex + 1) % normalCatalog.length;
  }
  const second = input.currentMode === 'SAME' ? first : normalCatalog[secondIndex];
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
    const persisted = Object.hasOwn(persistedById, mission.id) ? persistedById[mission.id] : null;
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

export const MAX_MISSION_IMPORT_COUNT = 100;
const VALID_IMPORTED_MISSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export type MissionImportFailureReason =
  | 'INVALID_JSON'
  | 'INVALID_FORMAT'
  | 'TOO_MANY_MISSIONS'
  | 'INVALID_MISSION';

export type MissionImportParseResult =
  | { ok: true; missions: Mission[] }
  | { ok: false; reason: MissionImportFailureReason; detail?: string };

function sanitizeOptionalShortField(value: unknown, fallback: string, maxLength: number): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  if (trimmed.length > maxLength) return null;
  return trimmed;
}

/** Exports missions as formatted JSON compatible with parseImportedMissionsJson. */
export function exportMissionsToJson(missions: readonly Mission[]): string {
  const normalized = missions.map(mission => ({
    id: mission.id,
    area: mission.area || 'ALL',
    region: mission.region || 'ALL',
    title: mission.title,
    description: mission.description,
    points: mission.points,
    type: mission.type,
    ...(typeof mission.lat === 'number' && Number.isFinite(mission.lat) ? { lat: mission.lat } : {}),
    ...(typeof mission.lng === 'number' && Number.isFinite(mission.lng) ? { lng: mission.lng } : {}),
    ...(typeof mission.isFinalMission === 'boolean' ? { isFinalMission: mission.isFinalMission } : {}),
  }));
  return JSON.stringify(normalized, null, 2);
}

/** Parses and validates an imported custom mission JSON payload (array or `{ missions: [...] }`). */
export function parseImportedMissionsJson(rawJson: string): MissionImportParseResult {
  if (typeof rawJson !== 'string' || rawJson.trim().length === 0) {
    return { ok: false, reason: 'INVALID_JSON', detail: 'JSON文字列が空です' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: 'INVALID_JSON', detail: 'JSONの構文が正しくありません' };
  }

  const rawItems = Array.isArray(parsed)
    ? parsed
    : (isRecord(parsed) && Array.isArray(parsed.missions) ? parsed.missions : null);
  if (!rawItems) {
    return { ok: false, reason: 'INVALID_FORMAT', detail: 'ミッション配列（[...] または { "missions": [...] }）を指定してください' };
  }
  if (rawItems.length === 0) {
    return { ok: false, reason: 'INVALID_FORMAT', detail: '少なくとも1件のミッションが必要です' };
  }
  if (rawItems.length > MAX_MISSION_IMPORT_COUNT) {
    return {
      ok: false,
      reason: 'TOO_MANY_MISSIONS',
      detail: `一度にインポートできるミッションは最大${MAX_MISSION_IMPORT_COUNT}件です`,
    };
  }

  const seenIds = new Set<string>();
  const missions: Mission[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index];
    const rowLabel = `${index + 1}件目`;
    if (!isRecord(item)) {
      return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: オブジェクト形式で指定してください` };
    }

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    if (!title || title.length > 120) {
      return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: title は1〜120文字で指定してください` };
    }
    if (!description || description.length > 500) {
      return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: description は1〜500文字で指定してください` };
    }
    if (typeof item.type !== 'string' || !missionTypes.has(item.type)) {
      return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: type は PHOTO または CHECKIN を指定してください` };
    }
    if (typeof item.points !== 'number' || !Number.isInteger(item.points) || item.points < 1 || item.points > 100) {
      return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: points は1〜100の整数を指定してください` };
    }

    const area = sanitizeOptionalShortField(item.area, 'ALL', 60);
    const region = sanitizeOptionalShortField(item.region, 'ALL', 60);
    if (area === null || region === null) {
      return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: area / region は60文字以内の文字列で指定してください` };
    }

    let id: string;
    if (item.id === undefined || item.id === null || (typeof item.id === 'string' && item.id.trim().length === 0)) {
      let seq = index + 1;
      id = `custom_import_${seq}`;
      while (seenIds.has(id)) {
        seq += 1;
        id = `custom_import_${seq}`;
      }
    } else if (typeof item.id === 'string' && VALID_IMPORTED_MISSION_ID.test(item.id.trim())) {
      id = item.id.trim();
    } else {
      return {
        ok: false,
        reason: 'INVALID_MISSION',
        detail: `${rowLabel}: id は半角英数字・アンダースコア・ハイフン（80文字以内）で指定してください`,
      };
    }

    if (seenIds.has(id)) {
      return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: ミッションID "${id}" が重複しています` };
    }
    seenIds.add(id);

    const hasLat = item.lat !== undefined && item.lat !== null;
    const hasLng = item.lng !== undefined && item.lng !== null;
    if (hasLat !== hasLng) {
      return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: lat と lng は両方指定するか両方省略してください` };
    }
    let lat: number | undefined;
    let lng: number | undefined;
    if (hasLat && hasLng) {
      if (
        typeof item.lat !== 'number' || !Number.isFinite(item.lat) || item.lat < -90 || item.lat > 90
        || typeof item.lng !== 'number' || !Number.isFinite(item.lng) || item.lng < -180 || item.lng > 180
      ) {
        return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: lat/lng の座標範囲が不正です` };
      }
      lat = item.lat;
      lng = item.lng;
    }

    if (item.isFinalMission !== undefined && typeof item.isFinalMission !== 'boolean') {
      return { ok: false, reason: 'INVALID_MISSION', detail: `${rowLabel}: isFinalMission は boolean で指定してください` };
    }

    missions.push({
      id,
      area,
      region,
      title,
      description,
      points: item.points,
      type: item.type as Mission['type'],
      ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}),
      ...(typeof item.isFinalMission === 'boolean' ? { isFinalMission: item.isFinalMission } : {}),
    });
  }

  return { ok: true, missions };
}

