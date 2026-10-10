import { FINAL_MISSIONS } from '../../../src/game/finalMissions';
import { resolveAdminPhaseTransition } from '../../../src/game/adminPhaseTransition';
import type { AdminPhaseAction } from '../../../src/game/adminPhaseTransition';

export type AdminPhaseFailureReason = 'UNAUTHENTICATED' | 'PERMISSION_DENIED' | 'INVALID_ARGUMENT' | 'CONFIG_NOT_FOUND' | 'INVALID_CONFIG' | 'TRANSITION_NOT_ALLOWED' | 'FINAL_MISSION_NOT_FOUND' | 'PERSISTENCE_ERROR';
export class AdminPhaseServiceError extends Error {
  constructor(readonly reason: AdminPhaseFailureReason) { super(reason); this.name = 'AdminPhaseServiceError'; }
}
export interface AdminPhaseReceipt { action: AdminPhaseAction; requestId: string; oldPhase: string; newPhase: string; selectedFinalMissionId?: string; duplicate?: boolean }
export interface AdminPhaseTransaction {
  readAdmin(uid: string): Promise<boolean>;
  readReceipt(uid: string, requestId: string): Promise<Record<string, unknown> | null>;
  readConfig(): Promise<Record<string, unknown> | null>;
  readMission(id: string): Promise<Record<string, unknown> | null>;
  writeTransition(uid: string, requestId: string, config: Record<string, unknown>, receipt: AdminPhaseReceipt): void;
}
export interface AdminPhaseStore { runTransaction<T>(work: (transaction: AdminPhaseTransaction) => Promise<T>): Promise<T> }
export interface AdminPhaseRuntime { now(): number; random(): number; createId(): string }
export interface AdminPhaseSuccess { ok: true; action: AdminPhaseAction; oldPhase: string; newPhase: string; selectedFinalMissionId?: string; duplicate: boolean }
const actions: readonly AdminPhaseAction[] = ['START_DAY1', 'PAUSE', 'RESUME', 'END_DAY1', 'START_DAY2', 'START_FINAL', 'END_GAME'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missionTypes = ['CHECKIN', 'PHOTO'];
function fail(reason: AdminPhaseFailureReason): never { throw new AdminPhaseServiceError(reason); }
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function parseRequest(v: unknown): { action: AdminPhaseAction; requestId: string } {
  if (!record(v) || Object.keys(v).length !== 2 || !Object.hasOwn(v, 'action') || !Object.hasOwn(v, 'requestId')
      || typeof v.action !== 'string' || !actions.includes(v.action as AdminPhaseAction)
      || typeof v.requestId !== 'string' || !uuid.test(v.requestId)) fail('INVALID_ARGUMENT');
  return { action: v.action as AdminPhaseAction, requestId: v.requestId };
}
function parseReceipt(value: Record<string, unknown>, action: AdminPhaseAction, requestId: string): AdminPhaseSuccess {
  if (value.action !== action || value.requestId !== requestId || typeof value.oldPhase !== 'string' || typeof value.newPhase !== 'string') fail('PERSISTENCE_ERROR');
  return { ok: true, action, oldPhase: value.oldPhase, newPhase: value.newPhase, ...(typeof value.selectedFinalMissionId === 'string' ? { selectedFinalMissionId: value.selectedFinalMissionId } : {}), duplicate: true };
}
function validMission(value: Record<string, unknown> | null, id: string): boolean {
  return !!value && value.id === id && typeof value.area === 'string' && typeof value.region === 'string'
    && typeof value.title === 'string' && value.title.trim().length > 0 && typeof value.description === 'string'
    && Number.isFinite(value.points) && (value.points as number) >= 0 && missionTypes.includes(value.type as string);
}
function logList(config: Record<string, unknown>, log: Record<string, unknown>): unknown[] {
  if (config.logs !== undefined && !Array.isArray(config.logs)) fail('INVALID_CONFIG');
  return [log, ...((config.logs ?? []) as unknown[])].slice(0, 200);
}
export async function transitionGamePhaseForAdmin(authUid: string, request: unknown, store: AdminPhaseStore, runtime: AdminPhaseRuntime): Promise<AdminPhaseSuccess> {
  if (typeof authUid !== 'string' || authUid.length === 0) fail('UNAUTHENTICATED');
  const { action, requestId } = parseRequest(request);
  const now = runtime.now();
  const random = action === 'START_FINAL' ? runtime.random() : 0;
  const logId = runtime.createId();
  if (!Number.isFinite(now) || now < 0 || !Number.isFinite(random) || random < 0 || random >= 1 || typeof logId !== 'string' || !logId) fail('PERSISTENCE_ERROR');
  const selectedId = action === 'START_FINAL' ? FINAL_MISSIONS[Math.floor(random * FINAL_MISSIONS.length)]?.id : undefined;
  if (action === 'START_FINAL' && !selectedId) fail('INVALID_CONFIG');
  try {
    return await store.runTransaction(async tx => {
      if (!await tx.readAdmin(authUid)) fail('PERMISSION_DENIED');
      const prior = await tx.readReceipt(authUid, requestId);
      if (prior) return parseReceipt(prior, action, requestId);
      const config = await tx.readConfig();
      if (!config) fail('CONFIG_NOT_FOUND');
      let mission: Record<string, unknown> | null = null;
      if (action === 'START_FINAL') mission = await tx.readMission(selectedId!);
      const resolved = resolveAdminPhaseTransition({ currentPhase: config.gameStatus, action, now, ...(selectedId ? { finalMissionId: selectedId } : {}) });
      if (!resolved.allowed) {
        if (resolved.reason === 'INVALID_PHASE') fail('INVALID_CONFIG');
        if (resolved.reason === 'INVALID_ACTION') fail('INVALID_ARGUMENT');
        fail('TRANSITION_NOT_ALLOWED');
      }
      if (action === 'START_FINAL' && !validMission(mission, selectedId!)) fail('FINAL_MISSION_NOT_FOUND');
      const audit = { id: logId, timestamp: now, type: 'SYSTEM', actorUid: authUid, action, oldPhase: resolved.oldPhase, newPhase: resolved.newPhase, ...(selectedId ? { selectedFinalMissionId: selectedId } : {}), message: `フェーズ変更: ${resolved.newPhase}${selectedId ? ` (Final Mission: ${selectedId})` : ''}` };
      const receipt: AdminPhaseReceipt = { action, requestId, oldPhase: resolved.oldPhase, newPhase: resolved.newPhase, ...(selectedId ? { selectedFinalMissionId: selectedId } : {}) };
      tx.writeTransition(authUid, requestId, { ...resolved.updates, logs: logList(config, audit) }, receipt);
      return { ok: true, action, oldPhase: resolved.oldPhase, newPhase: resolved.newPhase, ...(selectedId ? { selectedFinalMissionId: selectedId } : {}), duplicate: false };
    });
  } catch (error) {
    if (error instanceof AdminPhaseServiceError) throw error;
    throw new AdminPhaseServiceError('PERSISTENCE_ERROR');
  }
}
