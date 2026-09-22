import type { PlayerTeam, Role, Team, TeamRoles } from './types';

/**
 * Resolves the role assigned to a team. ADMIN keeps the existing UI behavior
 * of being treated as ONI, while unknown non-A teams retain the old B-side
 * fallback used by the application.
 */
export function getRoleForTeam(team: string, roles: TeamRoles): Role {
  if (team === 'ADMIN') return 'ONI';
  return team === 'A' ? roles.teamARole : roles.teamBRole;
}

export function getPlayerRole(player: PlayerTeam, roles: TeamRoles): Role {
  return getRoleForTeam(player.team, roles);
}

export function getTeamRole(team: Team, roles: TeamRoles): Role {
  return getRoleForTeam(team, roles);
}
