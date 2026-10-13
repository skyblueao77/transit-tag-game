import type { CaptureRejectionReason, CaptureSuccess } from '../game/capture.ts';

import type { SafetyAction, SafetyReasonCode } from '../game/playerSafety.ts';
import type { MissionReward } from '../game/missions.ts';
import type { MissionScoreResult } from '../game/scoring.ts';
import type { AdminRevealScope } from '../game/adminReveal.ts';


export interface CompleteMissionInput {
  missionId: string;
  expectedSessionId: string;
}

export type CompleteMissionFailureReason =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'SESSION_CHANGED'
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
  expectedSessionId: string;
}

export type CaptureFailureReason =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'SESSION_CHANGED'
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

export interface ActivateInvincibilityInput { expectedSessionId: string }

export type ActivateInvincibilityFailureReason =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'SESSION_CHANGED'
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

export interface StartWaitingInput { expectedSessionId: string }
export interface ResumeWaitingInput { expectedSessionId: string }

export type WaitingFailureReason =
  | 'INVALID_ARGUMENT'
  | 'SESSION_CHANGED'
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
  expectedSessionId: string;
}

export type SafetyActionFailureReason =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'SESSION_CHANGED'
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
  | {
      ok: true;
      changed: boolean;
      status: 'EMERGENCY' | 'RETIRED';
      projectionStatus: 'CREATED' | 'REFRESHED' | 'UNAVAILABLE' | 'STALE' | 'NOT_REQUIRED';
    }
  | { ok: false; reason: SafetyActionFailureReason };

export interface SafetyActionGateway {
  requestSafetyAction(input: SafetyActionInput): Promise<SafetyActionResult>;
}

export interface SwapTeamRolesInput {
  requestId: string;
  expectedSessionId: string;
}

export interface ResumePlayerInput {
  targetId: string;
  expectedSessionId: string;
}

export type AdminGameStateFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'SESSION_CHANGED'
  | 'PLAYER_NOT_FOUND'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_PLAYER_STATE'
  | 'INVALID_TEAM'
  | 'INVALID_GAME_CONFIG'
  | 'INVALID_ROSTER'
  | 'INVALID_STATUS'
  | 'ROSTER_TOO_LARGE'
  | 'PERSISTENCE_ERROR';

export type SwapTeamRolesResult =
  | {
      ok: true;
      replayed: boolean;
      teamARole: 'ONI' | 'RUNNER';
      teamBRole: 'ONI' | 'RUNNER';
      nextRevealTime: number;
      newOniTeam: 'A' | 'B';
    }
  | { ok: false; reason: AdminGameStateFailureReason };

export type ResumePlayerResult =
  | { ok: true; resumed: boolean; status: 'ACTIVE' }
  | { ok: false; reason: AdminGameStateFailureReason };

export interface AdminGameStateGateway {
  swapTeamRoles(input: SwapTeamRolesInput): Promise<SwapTeamRolesResult>;
  resumePlayer(input: ResumePlayerInput): Promise<ResumePlayerResult>;
}

export interface AdminRevealInput {
  scope: AdminRevealScope;
  durationMinutes: number;
  requestId: string;
  expectedSessionId: string;
}

export type AdminRevealFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'SESSION_CHANGED'
  | 'REQUEST_ID_REUSED'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_GAME_CONFIG'
  | 'INVALID_ROSTER'
  | 'ZERO_VALID_LOCATIONS'
  | 'WRITE_LIMIT_EXCEEDED'
  | 'PERSISTENCE_ERROR';

export type AdminRevealResult =
  | {
      ok: true;
      scope: AdminRevealScope;
      expiresAt: number;
      projectedCount: number;
      skippedCount: number;
      duplicate: boolean;
    }
  | { ok: false; reason: AdminRevealFailureReason };

export interface AdminRevealGateway {
  revealPlayerLocations(input: AdminRevealInput): Promise<AdminRevealResult>;
}

export type TransitionGamePhaseAction = 'START_DAY1' | 'PAUSE' | 'RESUME' | 'END_DAY1' | 'START_DAY2' | 'START_FINAL' | 'END_GAME';
export interface TransitionGamePhaseInput { action: TransitionGamePhaseAction; requestId: string; expectedSessionId: string }
export type TransitionGamePhaseFailureReason = 'UNAUTHENTICATED' | 'PERMISSION_DENIED' | 'INVALID_ARGUMENT' | 'SESSION_CHANGED' | 'CONFIG_NOT_FOUND' | 'INVALID_CONFIG' | 'TRANSITION_NOT_ALLOWED' | 'FINAL_MISSION_NOT_FOUND' | 'PERSISTENCE_ERROR';
export type TransitionGamePhaseResult = { ok: true; action: TransitionGamePhaseAction; oldPhase: string; newPhase: string; selectedFinalMissionId?: string; duplicate: boolean } | { ok: false; reason: TransitionGamePhaseFailureReason };
export interface AdminPhaseGateway { transitionGamePhase(input: TransitionGamePhaseInput): Promise<TransitionGamePhaseResult> }

export type MissionMode = 'SAME' | 'DIFFERENT';
export interface SetMissionModeInput { mode: MissionMode; requestId: string; expectedSessionId: string }
export type AssignMissionsInput =
  | { strategy: 'MANUAL'; target: 'TEAM_A' | 'TEAM_B'; missionId: string; requestId: string; expectedSessionId: string }
  | { strategy: 'RANDOM'; target: 'BOTH'; requestId: string; expectedSessionId: string };
export interface SyncMissionCatalogInput { requestId: string; expectedSessionId: string }
export type AdminMissionFailureReason = 'UNAUTHENTICATED' | 'PERMISSION_DENIED' | 'INVALID_ARGUMENT' | 'SESSION_CHANGED' | 'REQUEST_ID_REUSED' | 'CONFIG_NOT_FOUND' | 'INVALID_CONFIG' | 'INVALID_PHASE' | 'ASSIGNMENT_NOT_ALLOWED' | 'INVALID_MISSION' | 'PERSISTENCE_ERROR';
export type SetMissionModeResult =
  | { ok: true; action: 'setMissionMode'; mode: MissionMode; changed: boolean; duplicate: boolean }
  | { ok: false; reason: AdminMissionFailureReason };
export type AssignMissionsResult =
  | { ok: true; action: 'assignMissions'; strategy: 'MANUAL' | 'RANDOM'; target: 'TEAM_A' | 'TEAM_B' | 'BOTH'; activeMissionA?: string; activeMissionB?: string; selectedMissionIds: string[]; duplicate: boolean }
  | { ok: false; reason: AdminMissionFailureReason };
export type SyncMissionCatalogResult =
  | { ok: true; action: 'syncMissionCatalog'; createdCount: number; updatedCount: number; unchangedCount: number; totalManagedCount: number; duplicate: boolean }
  | { ok: false; reason: AdminMissionFailureReason };
export interface AdminMissionGateway {
  setMissionMode(input: SetMissionModeInput): Promise<SetMissionModeResult>;
  assignMissions(input: AssignMissionsInput): Promise<AssignMissionsResult>;
  syncMissionCatalog(input: SyncMissionCatalogInput): Promise<SyncMissionCatalogResult>;
}

export type ScoreAdjustmentTeam = 'A' | 'B';
export type ScoreAdjustmentReasonCode = 'CORRECTION' | 'BONUS' | 'PENALTY' | 'OTHER';
export interface AdjustTeamScoreInput {
  team: ScoreAdjustmentTeam;
  delta: number;
  reasonCode: ScoreAdjustmentReasonCode;
  requestId: string;
  expectedSessionId: string;
}
export type AdminScoreAdjustmentFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'SESSION_CHANGED'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_CONFIG'
  | 'SCORE_BELOW_ZERO'
  | 'REQUEST_ID_REUSED'
  | 'PERSISTENCE_ERROR';
export type AdjustTeamScoreResult =
  | {
      ok: true;
      team: ScoreAdjustmentTeam;
      delta: number;
      reasonCode: ScoreAdjustmentReasonCode;
      previousScore: number;
      nextScore: number;
      duplicate: boolean;
    }
  | { ok: false; reason: AdminScoreAdjustmentFailureReason };
export interface AdminScoreAdjustmentGateway {
  adjustTeamScore(input: AdjustTeamScoreInput): Promise<AdjustTeamScoreResult>;
}

export interface InitializeGameSessionInput { requestId: string }
export type InitializeGameSessionFailureReason = 'UNAUTHENTICATED' | 'PERMISSION_DENIED' | 'INVALID_ARGUMENT' | 'CONFIG_NOT_FOUND' | 'INVALID_CONFIG' | 'SESSION_CHANGED' | 'ROSTER_TOO_LARGE' | 'PERSISTENCE_ERROR';
export type InitializeGameSessionResult =
  | { ok: true; gameSessionId: string; sessionStartedAt: number; sessionSchemaVersion: number; duplicate: boolean; alreadyInitialized: boolean }
  | { ok: false; reason: InitializeGameSessionFailureReason };
export interface InitializeGameSessionGateway {
  initialize(input: InitializeGameSessionInput): Promise<InitializeGameSessionResult>;
}

export type GameResetFailureReason =
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENT'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_CONFIG'
  | 'RESET_NOT_READY'
  | 'CONFIRMATION_NOT_FOUND'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_ALREADY_USED'
  | 'SESSION_CHANGED'
  | 'CONFIRMATION_STALE'
  | 'RESET_TOO_LARGE'
  | 'REQUEST_ID_REUSED'
  | 'PERSISTENCE_ERROR'
  | 'INTERNAL';

export interface PrepareGameResetInput { expectedSessionId: string }
export interface PrepareGameResetPreview {
  confirmationToken: string;
  expiresAt: number;
  currentSessionId: string | null;
  proposedSessionId: string;
  sessionSchemaVersion: number;
  participantCount: number;
  privateLocationCount: number;
  exposedLocationCount: number;
  emergencyProjectionCount: number;
  estimatedWriteCount: number;
  resetReady: boolean;
  warningCodes: ('SESSION_SCOPE_NOT_READY' | 'RESET_TOO_LARGE')[];
}
export type PrepareGameResetResult =
  | { ok: true; preview: PrepareGameResetPreview }
  | { ok: false; reason: GameResetFailureReason };
export interface ExecuteGameResetInput { confirmationToken: string; requestId: string; expectedSessionId: string }
export type ExecuteGameResetResult =
  | { ok: true; executed: true; newSessionId: string }
  | { ok: false; reason: GameResetFailureReason };
export interface AdminGameResetGateway {
  prepareGameReset(input: PrepareGameResetInput): Promise<PrepareGameResetResult>;
  executeGameReset(input: ExecuteGameResetInput): Promise<ExecuteGameResetResult>;
}
