import type { CaptureRejectionReason, CaptureSuccess } from '../game/capture.ts';

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
