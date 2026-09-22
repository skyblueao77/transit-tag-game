export type { GameStatus, PlayerTeam, Role, Team, TeamRoles } from './types';
export { getPlayerRole, getRoleForTeam, getTeamRole } from './roles';
export {
  canCapture,
  canScore,
  canUpdateLocation,
  canUsePowerup,
  isGameActive,
  isGamePaused,
} from './phases';
