import type { GameStatus, Role } from './types';
import { canUsePowerup } from './phases.ts';
import { INVINCIBILITY_DURATION_MS } from './time.ts';

export interface InvincibilityActivationInput {
  role: Role;
  invincibleCards: number;
  invincibleUntil?: number;
  phase: GameStatus;
  now: number;
}

export type InvincibilityActivationResult =
  | { allowed: true; cardDelta: -1; invincibleUntil: number; duration: number }
  | { allowed: false; reason: 'ROLE' | 'NO_CARDS' | 'PHASE' | 'ALREADY_ACTIVE' };

export function canActivateInvincibility(input: InvincibilityActivationInput): boolean {
  return activateInvincibility(input).allowed;
}

export function activateInvincibility(
  input: InvincibilityActivationInput,
): InvincibilityActivationResult {
  if (input.role !== 'RUNNER') return { allowed: false, reason: 'ROLE' };
  if (input.invincibleCards < 1) return { allowed: false, reason: 'NO_CARDS' };
  if (!canUsePowerup(input.phase)) return { allowed: false, reason: 'PHASE' };
  if (input.invincibleUntil !== undefined && input.invincibleUntil > input.now) {
    return { allowed: false, reason: 'ALREADY_ACTIVE' };
  }

  return {
    allowed: true,
    cardDelta: -1,
    duration: INVINCIBILITY_DURATION_MS,
    invincibleUntil: input.now + INVINCIBILITY_DURATION_MS,
  };
}
