export type Role = 'ONI' | 'RUNNER';

export type Team = 'A' | 'B' | 'ADMIN';

export type GameStatus =
  | 'PRE_GAME'
  | 'DAY1_ACTIVE'
  | 'DAY1_PAUSED'
  | 'DAY1_ENDED'
  | 'DAY2_ACTIVE'
  | 'DAY2_PAUSED'
  | 'FINAL_MISSION'
  | 'GAME_OVER';

export interface TeamRoles {
  teamARole: Role;
  teamBRole: Role;
}

export interface PlayerTeam {
  team: string;
}
