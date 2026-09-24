import { activateInvincibility as resolveInvincibility } from '../game/powerups.ts';
import type {
  ActivateInvincibilityInput,
  ActivateInvincibilityResult,
  PowerupStore,
} from './gameplayPorts.ts';

export async function activateInvincibility(
  input: ActivateInvincibilityInput,
  store: PowerupStore,
): Promise<ActivateInvincibilityResult> {
  const activation = resolveInvincibility({
    role: input.role,
    invincibleCards: input.cards,
    invincibleUntil: input.invincibleUntil,
    phase: input.phase,
    now: input.now,
  });

  if (activation.allowed === false) {
    return {
      ok: false,
      reason: 'INVINCIBILITY_REJECTED',
      domainReason: activation.reason,
    };
  }

  try {
    await store.applyInvincibility({
      playerId: input.playerId,
      cardDelta: activation.cardDelta,
      invincibleUntil: activation.invincibleUntil,
    });
    return { ok: true, activation };
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
