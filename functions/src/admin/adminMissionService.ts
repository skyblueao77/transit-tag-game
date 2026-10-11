import { MISSIONS } from '../../../constants';
import { FINAL_MISSIONS } from '../../../src/game/finalMissions';
import {
  planMissionCatalogSync,
  resolveMissionAssignment,
  resolveMissionModeChange,
  validateCanonicalMission,
} from '../../../src/game/adminMission';
import type { Mission } from '../../../types';
import type { MissionAssignmentStrategy, MissionAssignmentTarget, MissionMode } from '../../../src/game/adminMission';

export type AdminMissionAction = 'setMissionMode' | 'assignMissions' | 'syncMissionCatalog';
export type AdminMissionFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_CONFIG'
  | 'INVALID_PHASE'
  | 'ASSIGNMENT_NOT_ALLOWED'
  | 'INVALID_MISSION'
  | 'PERSISTENCE_ERROR';

export class AdminMissionServiceError extends Error {
  constructor(readonly reason: AdminMissionFailureReason) {
    super(reason);
    this.name = 'AdminMissionServiceError';
  }
}

export interface AdminMissionReceipt {
  action: AdminMissionAction;
  requestId: string;
  result: Record<string, unknown>;
}

export interface AdminMissionTransaction {
  readAdmin(uid: string): Promise<boolean>;
  readReceipt(uid: string, action: AdminMissionAction, requestId: string): Promise<Record<string, unknown> | null>;
  readConfig(): Promise<Record<string, unknown> | null>;
  readMissions(ids: readonly string[]): Promise<Record<string, Record<string, unknown> | null>>;
  updateConfig(patch: Record<string, unknown>): void;
  upsertMission(id: string, mission: Mission): void;
  createReceipt(uid: string, action: AdminMissionAction, requestId: string, receipt: AdminMissionReceipt): void;
}

export interface AdminMissionStore {
  runTransaction<T>(work: (transaction: AdminMissionTransaction) => Promise<T>): Promise<T>;
}

export interface AdminMissionRuntime {
  now(): number;
  createId(): string;
  random(): number;
}

export type AdminMissionSuccess =
  | { ok: true; action: 'setMissionMode'; mode: MissionMode; changed: boolean; duplicate: boolean }
  | { ok: true; action: 'assignMissions'; strategy: MissionAssignmentStrategy; target: MissionAssignmentTarget; activeMissionA?: string; activeMissionB?: string; selectedMissionIds: string[]; duplicate: boolean }
  | { ok: true; action: 'syncMissionCatalog'; createdCount: number; updatedCount: number; unchangedCount: number; totalManagedCount: number; duplicate: boolean };

const canonicalMissions: readonly Mission[] = [...MISSIONS, ...FINAL_MISSIONS];
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const knownPhases = new Set(['PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_ACTIVE', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER']);

function fail(reason: AdminMissionFailureReason): never {
  throw new AdminMissionServiceError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(request: unknown):
  | { action: 'setMissionMode'; requestId: string; mode: MissionMode }
  | { action: 'assignMissions'; requestId: string; strategy: 'MANUAL'; target: 'TEAM_A' | 'TEAM_B'; missionId: string }
  | { action: 'assignMissions'; requestId: string; strategy: 'RANDOM'; target: 'BOTH' }
  | { action: 'syncMissionCatalog'; requestId: string } {
  if (!isRecord(request) || typeof request.requestId !== 'string' || !requestIdPattern.test(request.requestId)) {
    return fail('INVALID_ARGUMENT');
  }
  if (request.action === 'setMissionMode') {
    if (Object.keys(request).length !== 3 || !Object.hasOwn(request, 'mode')
      || (request.mode !== 'SAME' && request.mode !== 'DIFFERENT')) return fail('INVALID_ARGUMENT');
    return { action: 'setMissionMode', mode: request.mode, requestId: request.requestId };
  }
  if (request.action === 'assignMissions') {
    if (request.strategy === 'MANUAL') {
      if (Object.keys(request).length !== 5 || !Object.hasOwn(request, 'target') || !Object.hasOwn(request, 'missionId')
        || (request.target !== 'TEAM_A' && request.target !== 'TEAM_B')
        || typeof request.missionId !== 'string' || !missionIdPattern.test(request.missionId)) return fail('INVALID_ARGUMENT');
      return { action: 'assignMissions', strategy: 'MANUAL', target: request.target, missionId: request.missionId, requestId: request.requestId };
    }
    if (request.strategy === 'RANDOM' && Object.keys(request).length === 4 && request.target === 'BOTH') {
      return { action: 'assignMissions', strategy: 'RANDOM', target: 'BOTH', requestId: request.requestId };
    }
    return fail('INVALID_ARGUMENT');
  }
  if (request.action === 'syncMissionCatalog' && Object.keys(request).length === 2) {
    return { action: 'syncMissionCatalog', requestId: request.requestId };
  }
  return fail('INVALID_ARGUMENT');
}

function parseStoredResult(value: Record<string, unknown>, action: AdminMissionAction, requestId: string): AdminMissionSuccess {
  if (value.action !== action || value.requestId !== requestId || !isRecord(value.result) || value.result.ok !== true) {
    return fail('PERSISTENCE_ERROR');
  }
  const result = value.result;
  if (action === 'setMissionMode' && (result.action !== action || (result.mode !== 'SAME' && result.mode !== 'DIFFERENT') || typeof result.changed !== 'boolean')) return fail('PERSISTENCE_ERROR');
  if (action === 'assignMissions' && (result.action !== action || (result.strategy !== 'MANUAL' && result.strategy !== 'RANDOM') || !Array.isArray(result.selectedMissionIds))) return fail('PERSISTENCE_ERROR');
  if (action === 'syncMissionCatalog' && (result.action !== action || !['createdCount', 'updatedCount', 'unchangedCount', 'totalManagedCount'].every(key => Number.isInteger(result[key])))) return fail('PERSISTENCE_ERROR');
  return { ...result, duplicate: true } as AdminMissionSuccess;
}

function validateConfig(config: Record<string, unknown> | null): Record<string, unknown> {
  if (!config) return fail('CONFIG_NOT_FOUND');
  if (typeof config.gameStatus !== 'string' || !knownPhases.has(config.gameStatus)
    || (config.logs !== undefined && !Array.isArray(config.logs))) return fail('INVALID_CONFIG');
  return config;
}

function logsWithAudit(config: Record<string, unknown>, audit: Record<string, unknown>): unknown[] {
  return [audit, ...((config.logs ?? []) as unknown[])].slice(0, 200);
}

function mapCoreFailure(reason: string): AdminMissionFailureReason {
  switch (reason) {
    case 'INVALID_PHASE': return 'INVALID_PHASE';
    case 'ASSIGNMENT_NOT_ALLOWED': return 'ASSIGNMENT_NOT_ALLOWED';
    case 'INVALID_MISSION': case 'INVALID_CATALOG': return 'INVALID_MISSION';
    case 'INVALID_MODE': case 'INVALID_RANDOM': case 'INVALID_STRATEGY': case 'INVALID_TARGET': return 'INVALID_ARGUMENT';
    default: return 'INVALID_ARGUMENT';
  }
}

function validateRuntime(now: number, logId: string, randomValues: readonly number[]): void {
  if (!Number.isFinite(now) || now < 0 || typeof logId !== 'string' || logId.length === 0
    || randomValues.some(value => !Number.isFinite(value) || value < 0 || value >= 1)) fail('PERSISTENCE_ERROR');
}

export async function administerMissionForAdmin(
  authUid: string,
  request: unknown,
  store: AdminMissionStore,
  runtime: AdminMissionRuntime,
): Promise<AdminMissionSuccess> {
  if (typeof authUid !== 'string' || authUid.length === 0) fail('UNAUTHENTICATED');
  const parsed = parseRequest(request);
  const now = runtime.now();
  const logId = runtime.createId();
  const randomValues = parsed.action === 'assignMissions' && parsed.strategy === 'RANDOM'
    ? [runtime.random(), runtime.random()]
    : [];
  validateRuntime(now, logId, randomValues);

  try {
    return await store.runTransaction(async tx => {
      if (!await tx.readAdmin(authUid)) fail('PERMISSION_DENIED');
      const prior = await tx.readReceipt(authUid, parsed.action, parsed.requestId);
      if (prior) return parseStoredResult(prior, parsed.action, parsed.requestId);
      const config = validateConfig(await tx.readConfig());

      if (parsed.action === 'setMissionMode') {
        const decision = resolveMissionModeChange(config.missionMode, parsed.mode);
        if (!decision.allowed) fail(mapCoreFailure(decision.reason));
        const result: AdminMissionSuccess = { ok: true, action: parsed.action, mode: decision.mode, changed: decision.changed, duplicate: false };
        if (decision.changed) {
          const audit = { id: logId, timestamp: now, type: 'MISSION', actorUid: authUid, action: parsed.action, mode: decision.mode, message: `Mission mode changed to ${decision.mode}` };
          tx.updateConfig({ missionMode: decision.mode, logs: logsWithAudit(config, audit) });
        }
        tx.createReceipt(authUid, parsed.action, parsed.requestId, { action: parsed.action, requestId: parsed.requestId, result });
        return result;
      }

      if (parsed.action === 'assignMissions') {
        const randomCandidate = parsed.strategy === 'RANDOM'
          ? resolveMissionAssignment({ phase: config.gameStatus, currentMode: config.missionMode, catalog: MISSIONS, strategy: parsed.strategy, target: parsed.target, randomValues })
          : null;
        if (randomCandidate && !randomCandidate.allowed) fail(mapCoreFailure(randomCandidate.reason));
        const ids = parsed.strategy === 'MANUAL' ? [parsed.missionId] : randomCandidate!.allowed ? randomCandidate!.selectedMissionIds : [];
        const persisted = await tx.readMissions(ids);
        const decision = resolveMissionAssignment({
          phase: config.gameStatus,
          currentMode: config.missionMode,
          catalog: MISSIONS,
          persistedMissions: persisted,
          strategy: parsed.strategy,
          target: parsed.target,
          ...(parsed.strategy === 'MANUAL' ? { missionId: parsed.missionId } : { randomValues }),
        });
        if (!decision.allowed) fail(mapCoreFailure(decision.reason));
        const result: AdminMissionSuccess = {
          ok: true,
          action: parsed.action,
          strategy: parsed.strategy,
          target: parsed.target,
          ...(decision.activeMissionA ? { activeMissionA: decision.activeMissionA } : {}),
          ...(decision.activeMissionB ? { activeMissionB: decision.activeMissionB } : {}),
          selectedMissionIds: decision.selectedMissionIds,
          duplicate: false,
        };
        const patch: Record<string, unknown> = {};
        if (decision.activeMissionA) patch.activeMissionA = decision.activeMissionA;
        if (decision.activeMissionB) patch.activeMissionB = decision.activeMissionB;
        const audit = {
          id: logId,
          timestamp: now,
          type: 'MISSION',
          actorUid: authUid,
          action: parsed.action,
          strategy: parsed.strategy,
          target: parsed.target,
          selectedMissionIds: decision.selectedMissionIds,
          message: parsed.strategy === 'MANUAL'
            ? `Mission assigned to ${parsed.target}: ${decision.selectedMissionIds[0]}`
            : `Random missions assigned (${config.missionMode}): A=${decision.activeMissionA} B=${decision.activeMissionB}`,
        };
        tx.updateConfig({ ...patch, logs: logsWithAudit(config, audit) });
        tx.createReceipt(authUid, parsed.action, parsed.requestId, { action: parsed.action, requestId: parsed.requestId, result });
        return result;
      }

      const persisted = await tx.readMissions(canonicalMissions.map(mission => mission.id));
      const plan = planMissionCatalogSync(canonicalMissions, persisted);
      if (!plan.allowed) fail('INVALID_MISSION');
      const result: AdminMissionSuccess = {
        ok: true,
        action: parsed.action,
        createdCount: plan.createdCount,
        updatedCount: plan.updatedCount,
        unchangedCount: plan.unchangedCount,
        totalManagedCount: plan.totalManagedCount,
        duplicate: false,
      };
      const audit = {
        id: logId,
        timestamp: now,
        type: 'MISSION',
        actorUid: authUid,
        action: parsed.action,
        createdCount: plan.createdCount,
        updatedCount: plan.updatedCount,
        unchangedCount: plan.unchangedCount,
        totalManagedCount: plan.totalManagedCount,
        message: `Mission catalog synchronized: created ${plan.createdCount}, updated ${plan.updatedCount}, unchanged ${plan.unchangedCount}`,
      };
      for (const mission of plan.upserts) tx.upsertMission(mission.id, mission);
      tx.updateConfig({ logs: logsWithAudit(config, audit) });
      tx.createReceipt(authUid, parsed.action, parsed.requestId, { action: parsed.action, requestId: parsed.requestId, result });
      return result;
    });
  } catch (error) {
    if (error instanceof AdminMissionServiceError) throw error;
    throw new AdminMissionServiceError('PERSISTENCE_ERROR');
  }
}

export const ADMIN_MISSION_CATALOG = canonicalMissions;
export { validateCanonicalMission };
