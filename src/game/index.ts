export type { GameStatus, PlayerTeam, Role, Team, TeamRoles } from './types';
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
  SHINKANSEN_LIMIT_DURATION_MS,
  SHINKANSEN_WAIT_DURATION_MS,
} from './time';
export type { GameClockState } from './time';
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
