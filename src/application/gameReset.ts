import type {
  AdminGameResetGateway,
  ExecuteGameResetInput,
  ExecuteGameResetResult,
  PrepareGameResetInput,
  PrepareGameResetResult,
} from './gameplayPorts';

export async function prepareGameReset(
  input: PrepareGameResetInput,
  gateway: AdminGameResetGateway,
): Promise<PrepareGameResetResult> {
  try {
    return await gateway.prepareGameReset(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}

export async function executeGameReset(
  input: ExecuteGameResetInput,
  gateway: AdminGameResetGateway,
): Promise<ExecuteGameResetResult> {
  try {
    return await gateway.executeGameReset(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
