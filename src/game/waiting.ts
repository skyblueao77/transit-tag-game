import type { GameStatus } from './types';
import { isActiveUntil, remainingMilliseconds, remainingSeconds } from './time.ts';

export function isWaitingActive(
  status: GameStatus | string,
  waitingUntil: number | undefined,
  now: number,
): boolean {
  return status === 'WAITING' && isActiveUntil(waitingUntil, now);
}

export function isWaitingExpired(waitingUntil: number | undefined, now: number): boolean {
  return !isActiveUntil(waitingUntil, now);
}

export function remainingWaitingMilliseconds(
  waitingUntil: number | undefined,
  now: number,
): number {
  return remainingMilliseconds(waitingUntil, now);
}

export function remainingWaitingSeconds(waitingUntil: number | undefined, now: number): number {
  return remainingSeconds(waitingUntil, now);
}
