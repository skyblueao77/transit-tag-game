import type { GameStatus } from './types';

export function isGamePaused(status: GameStatus): boolean {
  return status.endsWith('_PAUSED');
}

export function isGameActive(status: GameStatus): boolean {
  return status === 'DAY1_ACTIVE'
    || status === 'DAY2_ACTIVE'
    || status === 'FINAL_MISSION';
}

// These permissions preserve the current client behavior: only paused phases
// are blocked here. Other phase-specific restrictions remain outside Core.
export function canScore(status: GameStatus): boolean {
  return !isGamePaused(status);
}

export function canCapture(status: GameStatus): boolean {
  return !isGamePaused(status);
}

export function canUsePowerup(status: GameStatus): boolean {
  return !isGamePaused(status);
}

export function canUpdateLocation(status: GameStatus): boolean {
  return !isGamePaused(status);
}
