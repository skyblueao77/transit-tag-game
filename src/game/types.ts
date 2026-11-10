export type Role = 'ONI' | 'RUNNER';

export type Team = 'A' | 'B' | 'ADMIN';

export type VictoryMode = 'SCORE_SWAP' | 'SURVIVAL';

export type ProtectionZoneType = 'NONE' | 'GREEN_CAR' | 'SAFE_ZONE';

export interface DynamicRuleSettings {
  victoryMode: VictoryMode;
  shinkansenMaxMinutes: number;
  shinkansenMaxSegments: number;
  postShinkansenWaitMinutes: number;
  periodicRevealIntervalMinutes: number;
  periodicRevealDurationMinutes: number;
  captureWaitMinutes: number;
  missionPenaltyRevealMinutes: number;
}

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

