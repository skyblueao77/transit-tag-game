import type {
  AdminGameStateGateway,
  ResumePlayerInput,
  ResumePlayerResult,
  SwapTeamRolesInput,
  SwapTeamRolesResult,
} from './gameplayPorts';

export async function swapTeamRoles(
  input: SwapTeamRolesInput,
  gateway: AdminGameStateGateway,
): Promise<SwapTeamRolesResult> {
  try {
    return await gateway.swapTeamRoles(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}

export async function resumePlayer(
  input: ResumePlayerInput,
  gateway: AdminGameStateGateway,
): Promise<ResumePlayerResult> {
  try {
    return await gateway.resumePlayer(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
