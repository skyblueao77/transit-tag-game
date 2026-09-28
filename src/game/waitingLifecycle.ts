import { isGameActive } from './phases.ts';
import {
  SHINKANSEN_LIMIT_DURATION_MS,
  SHINKANSEN_WAIT_DURATION_MS,
} from './time.ts';
import type { GameStatus, Role } from './types.ts';

export type WaitingStatus = 'ACTIVE' | 'WAITING' | 'EMERGENCY' | 'RETIRED' | 'CAPTURED';
export type WaitingActionKind = 'MANUAL' | 'SHINKANSEN_LIMIT' | 'RESUME';

export interface WaitingLifecycleInput {
  status: string;
  phase?: string;
  role?: Role;
  waitingUntil?: unknown;
  shinkansenStartTime?: unknown;
  now: number;
}

export type WaitingRejectionReason =
  | 'INVALID_STATUS'
  | 'INVALID_PHASE'
  | 'PHASE'
  | 'WRONG_ROLE'
  | 'INVALID_WAITING_STATE'
  | 'INVALID_SHINKANSEN_START'
  | 'SHINKANSEN_LIMIT_NOT_REACHED'
  | 'NOT_WAITING'
  | 'INVALID_WAITING_DEADLINE'
  | 'WAITING_NOT_EXPIRED'
  | 'INVALID_TIME';

export type WaitingLifecycleResult =
  | {
      allowed: true;
      changed: true;
      action: WaitingActionKind;
      status: 'WAITING' | 'ACTIVE';
      waitingUntil: number;
      shinkansenStartTime: null;
      duration: number;
    }
  | {
      allowed: true;
      changed: false;
      action: 'RESUME';
      status: 'ACTIVE';
      waitingUntil: number;
      shinkansenStartTime: null;
      duration: 0;
    }
  | { allowed: false; reason: WaitingRejectionReason };

const statuses: readonly WaitingStatus[] = [
  'ACTIVE', 'WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED',
];
const gameStatuses: readonly GameStatus[] = [
  'PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED',
  'DAY2_ACTIVE', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER',
];

function isValidOptionalTimestamp(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function activeStateIsWellFormed(input: WaitingLifecycleInput): boolean {
  return input.status === 'ACTIVE'
    && (input.waitingUntil === undefined
      || input.waitingUntil === null
      || input.waitingUntil === 0);
}


function validActivePhase(phase: unknown): phase is GameStatus {
  return typeof phase === 'string'
    && gameStatuses.includes(phase as GameStatus)
    && isGameActive(phase as GameStatus);
}

function waitingResult(
  action: 'MANUAL' | 'SHINKANSEN_LIMIT',
  now: number,
): Extract<WaitingLifecycleResult, { allowed: true; changed: true }> {
  return {
    allowed: true,
    changed: true,
    action,
    status: 'WAITING',
    waitingUntil: now + SHINKANSEN_WAIT_DURATION_MS,
    shinkansenStartTime: null,
    duration: SHINKANSEN_WAIT_DURATION_MS,
  };
}

export function startManualWaiting(input: WaitingLifecycleInput): WaitingLifecycleResult {
  if (!Number.isFinite(input.now) || input.now < 0) {
    return { allowed: false, reason: 'INVALID_TIME' };
  }
  if (!statuses.includes(input.status as WaitingStatus)) {
    return { allowed: false, reason: 'INVALID_STATUS' };
  }
  if (input.status !== 'ACTIVE') return { allowed: false, reason: 'INVALID_STATUS' };
  if (!isValidOptionalTimestamp(input.waitingUntil)
    || !isValidOptionalTimestamp(input.shinkansenStartTime)
    || !activeStateIsWellFormed(input)) {
    return { allowed: false, reason: 'INVALID_WAITING_STATE' };
  }
  if (input.role !== 'RUNNER') return { allowed: false, reason: 'WRONG_ROLE' };
  if (typeof input.phase !== 'string' || !gameStatuses.includes(input.phase as GameStatus)) {
    return { allowed: false, reason: 'INVALID_PHASE' };
  }
  if (!validActivePhase(input.phase)) return { allowed: false, reason: 'PHASE' };

  const result = waitingResult('MANUAL', input.now);
  if (!Number.isFinite(result.waitingUntil)) return { allowed: false, reason: 'INVALID_TIME' };
  return result;
}

export function startShinkansenLimitWaiting(input: WaitingLifecycleInput): WaitingLifecycleResult {
  if (!Number.isFinite(input.now) || input.now < 0) {
    return { allowed: false, reason: 'INVALID_TIME' };
  }
  if (!statuses.includes(input.status as WaitingStatus)) {
    return { allowed: false, reason: 'INVALID_STATUS' };
  }
  if (input.status !== 'ACTIVE') return { allowed: false, reason: 'INVALID_STATUS' };
  if (!isValidOptionalTimestamp(input.waitingUntil)
    || !isValidOptionalTimestamp(input.shinkansenStartTime)
    || !activeStateIsWellFormed(input)) {
    return { allowed: false, reason: 'INVALID_WAITING_STATE' };
  }
  if (typeof input.phase !== 'string' || !gameStatuses.includes(input.phase as GameStatus)) {
    return { allowed: false, reason: 'INVALID_PHASE' };
  }
  if (!validActivePhase(input.phase)) return { allowed: false, reason: 'PHASE' };
  if (typeof input.shinkansenStartTime !== 'number'
    || !Number.isFinite(input.shinkansenStartTime)
    || input.shinkansenStartTime <= 0) {
    return { allowed: false, reason: 'INVALID_SHINKANSEN_START' };
  }
  if (input.now - input.shinkansenStartTime <= SHINKANSEN_LIMIT_DURATION_MS) {
    return { allowed: false, reason: 'SHINKANSEN_LIMIT_NOT_REACHED' };
  }

  const result = waitingResult('SHINKANSEN_LIMIT', input.now);
  if (!Number.isFinite(result.waitingUntil)) return { allowed: false, reason: 'INVALID_TIME' };
  return result;
}

export function resumeExpiredWaiting(input: WaitingLifecycleInput): WaitingLifecycleResult {
  if (!Number.isFinite(input.now) || input.now < 0) {
    return { allowed: false, reason: 'INVALID_TIME' };
  }
  if (!statuses.includes(input.status as WaitingStatus)) {
    return { allowed: false, reason: 'INVALID_STATUS' };
  }
  if (!isValidOptionalTimestamp(input.waitingUntil)
    || !isValidOptionalTimestamp(input.shinkansenStartTime)) {
    return { allowed: false, reason: 'INVALID_WAITING_STATE' };
  }
  if (input.status === 'ACTIVE'
    && input.waitingUntil !== undefined
    && input.waitingUntil !== null
    && input.waitingUntil !== 0) {
    return { allowed: false, reason: 'INVALID_WAITING_STATE' };
  }
  if (input.status === 'ACTIVE') {
    return {
      allowed: true,
      changed: false,
      action: 'RESUME',
      status: 'ACTIVE',
      waitingUntil: 0,
      shinkansenStartTime: null,
      duration: 0,
    };
  }
  if (input.status !== 'WAITING') return { allowed: false, reason: 'NOT_WAITING' };
  if (typeof input.waitingUntil !== 'number'
    || !Number.isFinite(input.waitingUntil)
    || input.waitingUntil <= 0) {
    return { allowed: false, reason: 'INVALID_WAITING_DEADLINE' };
  }
  if (input.now < input.waitingUntil) return { allowed: false, reason: 'WAITING_NOT_EXPIRED' };

  return {
    allowed: true,
    changed: true,
    action: 'RESUME',
    status: 'ACTIVE',
    waitingUntil: 0,
    shinkansenStartTime: null,
    duration: 0,
  };
}

