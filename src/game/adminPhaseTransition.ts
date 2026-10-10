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
}

export type AdminPhaseTransitionResult =
  | { allowed: true; action: AdminPhaseAction; oldPhase: GameStatus; newPhase: GameStatus; updates: Record<string, unknown>; selectedFinalMissionId?: string }
  | { allowed: false; reason: AdminPhaseRejectionReason };

const phases: readonly GameStatus[] = ['PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_ACTIVE', 'DAY2_PAUSED', 'FINAL_MISSION', 'GAME_OVER'];
const actions: readonly AdminPhaseAction[] = ['START_DAY1', 'PAUSE', 'RESUME', 'END_DAY1', 'START_DAY2', 'START_FINAL', 'END_GAME'];
const transitions: Partial<Record<GameStatus, Partial<Record<AdminPhaseAction, GameStatus>>>> = {
  PRE_GAME: { START_DAY1: 'DAY1_ACTIVE' },
  DAY1_ACTIVE: { PAUSE: 'DAY1_PAUSED', END_DAY1: 'DAY1_ENDED' },
  DAY1_PAUSED: { RESUME: 'DAY1_ACTIVE' },
  DAY1_ENDED: { START_DAY2: 'DAY2_ACTIVE' },
  DAY2_ACTIVE: { PAUSE: 'DAY2_PAUSED', START_FINAL: 'FINAL_MISSION' },
  DAY2_PAUSED: { RESUME: 'DAY2_ACTIVE' },
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
      Object.assign(updates, { day: 1, startTime: input.now, isGameOver: false, isFinalMissionActive: false, activeFinalMissionId: null, finalMissionEndTime: 0 });
      break;
    case 'START_DAY2': updates.day = 2; break;
    case 'START_FINAL':
      Object.assign(updates, { isFinalMissionActive: true, activeFinalMissionId: input.finalMissionId, finalMissionEndTime: input.now + FINAL_MISSION_DURATION_MS, isGameOver: false });
      break;
    case 'END_GAME': Object.assign(updates, { isGameOver: true, isFinalMissionActive: false }); break;
  }
  return { allowed: true, action, oldPhase, newPhase, updates, ...(action === 'START_FINAL' ? { selectedFinalMissionId: input.finalMissionId } : {}) };
}
