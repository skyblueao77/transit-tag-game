import type {
  ActivateInvincibilityInput,
  ActivateInvincibilityResult,
  InvincibilityGateway,
} from './gameplayPorts.ts';

export async function activateInvincibility(
  input: ActivateInvincibilityInput,
  gateway: InvincibilityGateway,
): Promise<ActivateInvincibilityResult> {
  try {
    return await gateway.activate(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
