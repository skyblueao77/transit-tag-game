import type {
  CaptureInput,
  CaptureRejectionReason,
  CaptureSuccess,
} from '../game/capture.ts';
import type { GameStatus, Role } from '../game/types';
import type { MissionLike, MissionReward } from '../game/missions.ts';
import type { MissionScoreResult } from '../game/scoring.ts';
import type { InvincibilityActivationResult } from '../game/powerups.ts';

export interface MissionCompletionStore {
  applyMissionCompletion(input: {
    playerId: string;
    team: 'A' | 'B';
    teamScoreDelta: number;
    playerScoreDelta: number;
    invincibleCardDelta: number;
  }): Promise<void>;
}

export interface CompleteMissionInput {
  mission: MissionLike;
  isFinalMission: boolean;
  phase: GameStatus;
  randomValue: number;
  playerId: string;
  team: 'A' | 'B';
}

export type CompleteMissionResult =
  | { ok: true; reward: MissionReward; score: MissionScoreResult }
  | { ok: false; reason: 'MISSION_NOT_ALLOWED' | 'PERSISTENCE_ERROR' };

export interface CaptureStore {
  applyCapture(result: CaptureSuccess): Promise<void>;
}

export type CapturePlayerInput = CaptureInput;
export type CapturePlayerResult =
  | { ok: true; capture: CaptureSuccess }
  | { ok: false; reason: 'CAPTURE_REJECTED'; domainReason: CaptureRejectionReason }
  | { ok: false; reason: 'PERSISTENCE_ERROR' };

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
