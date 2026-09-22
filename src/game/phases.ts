import type { GameStatus } from './types';

export function isGamePaused(status: GameStatus): boolean {
  return status.endsWith('_PAUSED');
}

export function isGameActive(status: GameStatus): boolean {
  return status === 'DAY1_ACTIVE'
    || status === 'DAY2_ACTIVE'
    || status === 'FINAL_MISSION';
}

export function canScore(status: GameStatus): boolean {
  return status === 'DAY1_ACTIVE'
    || status === 'DAY2_ACTIVE'
    || status === 'FINAL_MISSION';
}

export function canCapture(status: GameStatus): boolean {
  return isGameActive(status);
}

export function canUsePowerup(status: GameStatus): boolean {
  return isGameActive(status);
}

/** Public/exposed location reveal, not private GPS collection. */
export function canRevealLocation(status: GameStatus): boolean {
  return status === 'DAY1_ACTIVE' || status === 'DAY2_ACTIVE';
}

/** Private GPS may continue in every non-terminal phase. */
export function canUpdatePrivateLocation(status: GameStatus): boolean {
  return status !== 'GAME_OVER';
}

// Kept as the existing API name for callers that mean private GPS updates.
export function canUpdateLocation(status: GameStatus): boolean {
  return canUpdatePrivateLocation(status);
}

export function canSendSOS(_status: GameStatus): boolean {
  return true;
}
