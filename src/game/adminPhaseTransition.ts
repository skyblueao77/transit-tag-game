import type { GameStatus } from './types';
import { FINAL_MISSION_DURATION_MS } from './time.ts';

export type AdminPhaseAction = 'START_DAY1' | 'PAUSE' | 'RESUME' | 'END_DAY1'
  | 'START_DAY2' | 'START_FINAL' | 'END_GAME';

export type AdminPhaseRejectionReason = 'INVALID_PHASE' | 'INVALID_ACTION' | 'TRANSITION_NOT_ALLOWED'
  | 'INVALID_TIME' | 'INVALID_FINAL_MISSION';

export interface AdminPhaseTransitionInput {
  currentPhase: unknown;
  action: unknown;
  now: number;
  finalMissionId?: string;
  currentStartTime?: unknown;
  pauseStartTime?: unknown;
  currentNextRevealTime?: unknown;
  currentFinalMissionEndTime?: unknown;
}

export type AdminPhaseTransitionResult =
  | { allowed: true; action: AdminPhaseAction; oldPhase: GameStatus; newPhase: GameStatus; updates: Record<string, unknown>; selectedFinalMissionId?: string }
  | { allowed: false; reason: AdminPhaseRejectionReason };

const phases: readonly GameStatus[] = ['PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_ACTIVE', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER'];
const actions: readonly AdminPhaseAction[] = ['START_DAY1', 'PAUSE', 'RESUME', 'END_DAY1', 'START_DAY2', 'START_FINAL', 'END_GAME'];
const transitions: Partial<Record<GameStatus, Partial<Record<AdminPhaseAction, GameStatus>>>> = {
  PRE_GAME: { START_DAY1: 'DAY1_ACTIVE' },
  DAY1_ACTIVE: { PAUSE: 'DAY1_PAUSED', END_DAY1: 'DAY1_ENDED', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  DAY1_PAUSED: { RESUME: 'DAY1_ACTIVE', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  DAY1_ENDED: { START_DAY2: 'DAY2_ACTIVE', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  DAY2_ACTIVE: { PAUSE: 'DAY2_PAUSED', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  DAY2_PAUSED: { RESUME: 'DAY2_ACTIVE', START_FINAL: 'FINAL_MISSION', END_GAME: 'GAME_OVER' },
  FINAL_MISSION: { END_GAME: 'GAME_OVER' },
};

export function resolveAdminPhaseTransition(input: AdminPhaseTransitionInput): AdminPhaseTransitionResult {
  if (!input || typeof input !== 'object' || !phases.includes(input.currentPhase as GameStatus)) return { allowed: false, reason: 'INVALID_PHASE' };
  if (!actions.includes(input.action as AdminPhaseAction)) return { allowed: false, reason: 'INVALID_ACTION' };
  const oldPhase = input.currentPhase as GameStatus;
  const action = input.action as AdminPhaseAction;
  const newPhase = transitions[oldPhase]?.[action];
  if (!newPhase) return { allowed: false, reason: 'TRANSITION_NOT_ALLOWED' };
  if (!Number.isFinite(input.now) || input.now < 0) return { allowed: false, reason: 'INVALID_TIME' };
  if (action === 'START_FINAL' && (typeof input.finalMissionId !== 'string' || input.finalMissionId.trim() === '')) return { allowed: false, reason: 'INVALID_FINAL_MISSION' };
  if (action === 'START_FINAL' && !Number.isFinite(input.now + FINAL_MISSION_DURATION_MS)) return { allowed: false, reason: 'INVALID_TIME' };
  const updates: Record<string, unknown> = { gameStatus: newPhase };
  switch (action) {
    case 'START_DAY1':
      Object.assign(updates, { day: 1, startTime: input.now, pauseStartTime: null, isGameOver: false, isFinalMissionActive: false, activeFinalMissionId: null, finalMissionEndTime: 0 });
      break;
    case 'START_DAY2':
      updates.day = 2;
      updates.startTime = input.now;
      updates.pauseStartTime = null;
      break;
    case 'PAUSE':
      updates.pauseStartTime = input.now;
      break;
    case 'RESUME': {
      const pausedDelta = typeof input.pauseStartTime === 'number' && Number.isFinite(input.pauseStartTime) && input.pauseStartTime >= 0
        ? Math.max(0, input.now - input.pauseStartTime)
        : 0;
      updates.pauseStartTime = null;
      if (pausedDelta > 0) {
        if (typeof input.currentStartTime === 'number' && Number.isFinite(input.currentStartTime) && input.currentStartTime > 0) {
          updates.startTime = input.currentStartTime + pausedDelta;
        }
        if (typeof input.currentNextRevealTime === 'number' && Number.isFinite(input.currentNextRevealTime) && input.currentNextRevealTime > 0) {
          updates.nextRevealTime = input.currentNextRevealTime + pausedDelta;
        }
        if (typeof input.currentFinalMissionEndTime === 'number' && Number.isFinite(input.currentFinalMissionEndTime) && input.currentFinalMissionEndTime > 0) {
          updates.finalMissionEndTime = input.currentFinalMissionEndTime + pausedDelta;
        }
      }
      break;
    }
    case 'START_FINAL':
      Object.assign(updates, { isFinalMissionActive: true, activeFinalMissionId: input.finalMissionId, finalMissionEndTime: input.now + FINAL_MISSION_DURATION_MS, pauseStartTime: null, isGameOver: false });
      break;
    case 'END_GAME': Object.assign(updates, { isGameOver: true, isFinalMissionActive: false, pauseStartTime: null }); break;
  }
  return { allowed: true, action, oldPhase, newPhase, updates, ...(action === 'START_FINAL' ? { selectedFinalMissionId: input.finalMissionId } : {}) };
}
