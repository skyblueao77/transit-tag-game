import type { CaptureRejectionReason, CaptureSuccess } from '../game/capture.ts';

import type { SafetyAction, SafetyReasonCode } from '../game/playerSafety.ts';
import type { MissionReward } from '../game/missions.ts';
import type { MissionScoreResult } from '../game/scoring.ts';


export interface CompleteMissionInput {
  missionId: string;
}

export type CompleteMissionFailureReason =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'PLAYER_NOT_ACTIVE'
  | 'INVALID_PLAYER_TEAM'
  | 'MISSION_NOT_FOUND'
  | 'MISSION_NOT_ACTIVE'
  | 'MISSION_NOT_ALLOWED'
  | 'ALREADY_COMPLETED'
  | 'PERSISTENCE_ERROR';

export type CompleteMissionResult =
  | {
      ok: true;
      missionId: string;
      reward: MissionReward;
      score: MissionScoreResult;
      isFinalMission: boolean;
    }
  | { ok: false; reason: CompleteMissionFailureReason };

export interface MissionCompletionGateway {
  completeMission(input: CompleteMissionInput): Promise<CompleteMissionResult>;
}

export interface CapturePlayerInput {
  targetId: string;
}

export type CaptureFailureReason =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'INVALID_CAPTOR_TEAM'
  | 'INVALID_TARGET_TEAM'
  | 'GAME_CONFIG_NOT_FOUND'
  | 'INVALID_GAME_STATE'
  | 'CAPTURE_REJECTED'
  | 'PERSISTENCE_ERROR';

export type CapturePlayerResult =
  | { ok: true; capture: CaptureSuccess }
  | {
      ok: false;
      reason: CaptureFailureReason;
      domainReason?: CaptureRejectionReason;
    };

export interface CaptureGateway {
  capture(input: CapturePlayerInput): Promise<CapturePlayerResult>;
}

export type ActivateInvincibilityInput = Record<string, never>;

export type ActivateInvincibilityFailureReason =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_PLAYER_STATE'
  | 'INVALID_GAME_CONFIG'
  | 'POWERUP_NOT_ALLOWED'
  | 'WRONG_ROLE'
  | 'NO_CARDS'
  | 'ALREADY_ACTIVE'
  | 'PERSISTENCE_ERROR';

export type ActivateInvincibilityResult =
  | {
      ok: true;
      remainingCards: number;
      invincibleUntil: number;
      duration: number;
    }
  | {
      ok: false;
      reason: ActivateInvincibilityFailureReason;
      domainReason?: 'PHASE';
    };

export interface InvincibilityGateway {
  activate(input: ActivateInvincibilityInput): Promise<ActivateInvincibilityResult>;
}

export type StartWaitingInput = Record<string, never>;
export type ResumeWaitingInput = Record<string, never>;

export type WaitingFailureReason =
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_PLAYER_STATE'
  | 'INVALID_GAME_CONFIG'
  | 'INVALID_TEAM'
  | 'PERSISTENCE_ERROR'
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

export type StartWaitingResult =
  | { ok: true; waitingUntil: number; duration: number }
  | { ok: false; reason: WaitingFailureReason };

export type ResumeWaitingResult =
  | { ok: true; resumed: boolean }
  | { ok: false; reason: WaitingFailureReason };

export interface WaitingGateway {
  startWaiting(input: StartWaitingInput): Promise<StartWaitingResult>;
  resumeWaiting(input: ResumeWaitingInput): Promise<ResumeWaitingResult>;
}

export interface SafetyActionInput {
  action: SafetyAction;
  reasonCode: SafetyReasonCode;
}

export type SafetyActionFailureReason =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_PLAYER_STATE'
  | 'INVALID_GAME_CONFIG'
  | 'INVALID_TEAM'
  | 'INVALID_ACTION'
  | 'INVALID_REASON_CODE'
  | 'REASON_ACTION_MISMATCH'
  | 'INVALID_STATUS'
  | 'RETIRED_TERMINAL'
  | 'PERSISTENCE_ERROR';

export type SafetyActionResult =
  | { ok: true; changed: boolean; status: 'EMERGENCY' | 'RETIRED' }
  | { ok: false; reason: SafetyActionFailureReason };

export interface SafetyActionGateway {
  requestSafetyAction(input: SafetyActionInput): Promise<SafetyActionResult>;
}
