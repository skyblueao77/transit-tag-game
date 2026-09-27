import type { CaptureRejectionReason, CaptureSuccess } from '../game/capture.ts';
import type { GameStatus, Role } from '../game/types';
import type { MissionReward } from '../game/missions.ts';
import type { MissionScoreResult } from '../game/scoring.ts';
import type { InvincibilityActivationResult } from '../game/powerups.ts';

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

export interface PowerupStore {
  applyInvincibility(input: {
    playerId: string;
    cardDelta: -1;
    invincibleUntil: number;
  }): Promise<void>;
}

export interface ActivateInvincibilityInput {
  playerId: string;
  role: Role;
  cards: number;
  invincibleUntil?: number;
  phase: GameStatus;
  now: number;
}

export type ActivateInvincibilityResult =
  | { ok: true; activation: Extract<InvincibilityActivationResult, { allowed: true }> }
  | {
      ok: false;
      reason: 'INVINCIBILITY_REJECTED';
      domainReason: Extract<InvincibilityActivationResult, { allowed: false }>['reason'];
    }
  | { ok: false; reason: 'PERSISTENCE_ERROR' };
