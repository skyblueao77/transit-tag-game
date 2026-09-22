/** Pure deadline helpers. All timestamps are Unix milliseconds supplied by callers. */
export function remainingMilliseconds(until: number | undefined, now: number): number {
  if (until === undefined) return 0;
  return Math.max(0, until - now);
}

export function remainingSeconds(until: number | undefined, now: number): number {
  return Math.floor(remainingMilliseconds(until, now) / 1000);
}

export function isExpired(until: number | undefined, now: number): boolean {
  return until === undefined || until <= now;
}

export function isActiveUntil(until: number | undefined, now: number): boolean {
  return until !== undefined && until > now;
}

/**
 * A pause-aware wall-clock projection. `pausedAt` and
 * `accumulatedPauseDuration` are persisted clock state, not a game status.
 * While paused, wall-clock movement is excluded from the projected game time.
 */
export interface GameClockState {
  pausedAt?: number;
  accumulatedPauseDuration: number;
}

export function gameTimeAt(state: GameClockState, wallClockNow: number): number {
  const currentPauseDuration = state.pausedAt === undefined
    ? 0
    : Math.max(0, wallClockNow - state.pausedAt);
  return wallClockNow - state.accumulatedPauseDuration - currentPauseDuration;
}

export function gameElapsedSince(
  startAt: number,
  state: GameClockState,
  wallClockNow: number,
): number {
  return Math.max(0, gameTimeAt(state, wallClockNow) - startAt);
}

export const INVINCIBILITY_DURATION_MS = 30 * 60 * 1000;
export const ONI_INITIAL_LOCK_DURATION_MS = 30 * 60 * 1000;
export const CAPTURE_WAIT_DURATION_MS = 30 * 60 * 1000;
export const SHINKANSEN_LIMIT_DURATION_MS = 2.5 * 60 * 60 * 1000;
export const SHINKANSEN_WAIT_DURATION_MS = 60 * 60 * 1000;
