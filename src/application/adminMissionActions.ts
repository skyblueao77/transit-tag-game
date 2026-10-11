import type {
  AdminMissionGateway,
  AssignMissionsInput,
  AssignMissionsResult,
  SetMissionModeInput,
  SetMissionModeResult,
  SyncMissionCatalogInput,
  SyncMissionCatalogResult,
} from './gameplayPorts';

export async function setMissionMode(
  input: SetMissionModeInput,
  gateway: AdminMissionGateway,
): Promise<SetMissionModeResult> {
  try { return await gateway.setMissionMode(input); }
  catch { return { ok: false, reason: 'PERSISTENCE_ERROR' }; }
}

export async function assignMissions(
  input: AssignMissionsInput,
  gateway: AdminMissionGateway,
): Promise<AssignMissionsResult> {
  try { return await gateway.assignMissions(input); }
  catch { return { ok: false, reason: 'PERSISTENCE_ERROR' }; }
}

export async function syncMissionCatalog(
  input: SyncMissionCatalogInput,
  gateway: AdminMissionGateway,
): Promise<SyncMissionCatalogResult> {
  try { return await gateway.syncMissionCatalog(input); }
  catch { return { ok: false, reason: 'PERSISTENCE_ERROR' }; }
}
