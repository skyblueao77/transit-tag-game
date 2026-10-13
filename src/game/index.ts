export type { GameStatus, PlayerTeam, Role, Team, TeamRoles } from './types';
export {
  GAME_SESSION_SCHEMA_VERSION,
  isValidGameSessionId,
  sessionScopedCompletionId,
  validateExpectedSession,
  validateGameSession,
} from './gameSession.ts';
export type { GameSessionFields, GameSessionValidation } from './gameSession.ts';
export {
  buildResetReceiptContract,
  isResetConfirmationExpired,
  isResetConfirmationStale,
  isResetSessionReady,
  isValidResetId,
  planFutureGameResetConfig,
  planFuturePlayerReset,
  planGameResetPreview,
  resolveResetReceiptReplay,
  validateExecuteGameResetRequest,
  validatePrepareGameResetRequest,
  validateResetConfig,
  RESET_CONFIRMATION_TTL_MS,
  RESET_MAX_ESTIMATED_WRITES,
  RESET_SESSION_SCHEMA_VERSION,
} from './gameReset';
export type {
  FutureGameResetConfigPatch,
  FuturePlayerResetPatch,
  ResetConfirmationSnapshot,
  ResetCounts,
  ResetDocumentIdentity,
  ResetParticipantDocument,
  ResetPreviewInput,
  ResetPreviewPlan,
  ResetReceiptContract,
  ResetReceiptReplay,
  ResetRequestValidation,
  ResetSessionState,
  ResetWarningCode,
} from './gameReset';
export { resolveAdminPlayerResume, resolveAdminRoleSwap } from './adminGameState';
export type {
  AdminPlayerResumeInput,
  AdminPlayerResumeResult,
  AdminPlayerStatus,
  AdminRoleSwapInput,
  AdminRoleSwapPlayer,
  AdminRoleSwapPlayerChange,
  AdminRoleSwapResult,
} from './adminGameState';
export { getPlayerRole, getRoleForTeam, getTeamRole } from './roles';
export {
  canCapture,
  canRevealLocation,
  canScore,
  canSendSOS,
  canUpdateLocation,
  canUpdatePrivateLocation,
  canUsePowerup,
  isGameActive,
  isGamePaused,
} from './phases';
export {
  calculateMissionReward,
  canCompleteFinalMission,
  canCompleteMission,
  canCompleteNormalMission,
  isSameMissionId,
} from './missions';
export {
  calculateMissionScore,
  LUCKY_REWARD_THRESHOLD,
} from './scoring';
export {
  gameElapsedSince,
  gameTimeAt,
  isActiveUntil,
  isExpired,
  remainingMilliseconds,
  remainingSeconds,
  INVINCIBILITY_DURATION_MS,
  ONI_INITIAL_LOCK_DURATION_MS,
  CAPTURE_WAIT_DURATION_MS,
  SHINKANSEN_LIMIT_DURATION_MS,
  SHINKANSEN_WAIT_DURATION_MS,
} from './time';
export type { GameClockState } from './time';
export { resolveLocationVisibility } from './reveal';
export { resolveAdminRevealPlan } from './adminReveal';
export {
  planMissionCatalogSync,
  resolveMissionAssignment,
  resolveMissionModeChange,
  validateCanonicalMission,
} from './adminMission';
export { resolveTeamScoreAdjustment } from './adminScoreAdjustment';
export type {
  ScoreAdjustmentField,
  ScoreAdjustmentReasonCode,
  ScoreAdjustmentRejectionReason,
  ScoreAdjustmentTeam,
  TeamScoreAdjustmentDecision,
} from './adminScoreAdjustment';
export type {
  MissionAdminPhase,
  MissionAdminRejectionReason,
  MissionAssignmentDecision,
  MissionAssignmentStrategy,
  MissionAssignmentTarget,
  MissionCatalogSyncPlan,
  MissionMode,
  MissionModeChangeDecision,
} from './adminMission';
export type {
  AdminRevealConfigField,
  AdminRevealInput,
  AdminRevealPlan,
  AdminRevealPlayer,
  AdminRevealScope,
  AdminRevealSnapshot,
  AdminRevealSkipReason,
} from './adminReveal';
export {
  EMERGENCY_LOCATION_FRESHNESS_MS,
  resolveEmergencyLocationProjection,
} from './emergencyLocationProjection';
export type {
  EmergencyLocationProjectionDecision,
  EmergencyLocationProjectionInput,
} from './emergencyLocationProjection';
export type {
  LocationVisibilityInput,
  LocationVisibilityMode,
  LocationVisibilityPlayer,
  LocationVisibilityResult,
} from './reveal';
export {
  activateInvincibility,
  canActivateInvincibility,
} from './powerups';
export type {
  InvincibilityActivationInput,
  InvincibilityActivationResult,
} from './powerups';
export {
  isWaitingActive,
  isWaitingExpired,
  remainingWaitingMilliseconds,
  remainingWaitingSeconds,
} from './waiting';
export {
  resumeExpiredWaiting,
  startManualWaiting,
  startShinkansenLimitWaiting,
} from './waitingLifecycle';
export type {
  WaitingActionKind,
  WaitingLifecycleInput,
  WaitingLifecycleResult,
  WaitingRejectionReason,
  WaitingStatus,
} from './waitingLifecycle';
export {
  CAPTURE_REWARD_POINTS,
  resolveCapture,
  validateCapture,
} from './capture';
export type {
  CaptureFailure,
  CaptureInput,
  CapturePlayer,
  CapturePlayerChange,
  CaptureRejectionReason,
  CaptureResult,
  CaptureSuccess,
} from './capture';
