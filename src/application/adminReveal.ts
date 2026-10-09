import type {
  AdminRevealGateway,
  AdminRevealInput,
  AdminRevealResult,
} from './gameplayPorts.ts';

export async function revealPlayerLocations(
  input: AdminRevealInput,
  gateway: AdminRevealGateway,
): Promise<AdminRevealResult> {
  try {
    return await gateway.revealPlayerLocations({
      scope: input.scope,
      durationMinutes: input.durationMinutes,
      requestId: input.requestId,
    });
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
