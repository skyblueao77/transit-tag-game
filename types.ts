
import type { DynamicRuleSettings, GameStatus, ProtectionZoneType, Role, VictoryMode } from './src/game/types';

export type { DynamicRuleSettings, GameStatus, ProtectionZoneType, Role, VictoryMode };



export interface GameLog {
  id: string;
  timestamp: number;
  message: string;
  type: 'CAPTURE' | 'MISSION' | 'SYSTEM' | 'EMERGENCY';
}

export interface User {
  id: string;
  name: string;
  role: Role;
  team: string;
  color: string;
  score: number;
  gameSessionId?: string;

  status: 'ACTIVE' | 'CAPTURED' | 'WAITING' | 'EMERGENCY' | 'RETIRED';
  invincibleUntil?: number;
  waitingUntil?: number;
  invincibleCards: number;
  lastStation?: string;
  shinkansenStartTime?: number;
  lastCompletionId?: string;
  protectionZone?: ProtectionZoneType;
  shinkansenSegmentCount?: number;
  penaltyRevealUntil?: number;
}

export interface PrivateLocation {
  gameSessionId: string;
  latitude: number;
  longitude: number;
  updatedAt?: unknown;
}

export type ExposedLocationScope = 'GLOBAL' | 'TEAM_A' | 'TEAM_B' | 'INDIVIDUAL' | 'PENALTY';
export type AdminRevealScope = 'GLOBAL' | 'TEAM_A' | 'TEAM_B';

export interface ExposedLocation {
  gameSessionId: string;
  latitude: number;
  longitude: number;
  capturedAt?: number;
  expiresAt: number;
  revealScope?: ExposedLocationScope;
}

export interface EmergencyLocationProjection {
  playerId: string;
  gameSessionId: string;
  latitude: number;
  longitude: number;
  projectedAt: number;
  sourceLocationUpdatedAt: number;
  expiresAt: number;
  safetyStatus: 'EMERGENCY';
  projectionKind: 'EMERGENCY';
}

export interface Mission {
  id: string;
  area: string;
  region: string;
  title: string;
  description: string;
  points: number;
  lat?: number;   // 座標不要ミッションはundefined（運営目視判定）
  lng?: number;
  type: 'CHECKIN' | 'PHOTO';
}

export interface GameConfig {
  currentArea: string;
  currentRegion: string;
  announcement: string;
  isGameEnded: boolean;
  isGameOver: boolean;
  isFinalMissionActive: boolean;
  finalMissionEndTime: number;
  day: number;
  goalLat: number;
  goalLng: number;
  
  startTime: number;
  gameStatus: GameStatus;

  broadcastMessage: string;
  broadcastTime: number;

  // ミッション管理
  missionMode: 'SAME' | 'DIFFERENT';
  activeMissionA: string | null;
  activeMissionB: string | null;
  activeFinalMissionId: string | null; // 最終ミッション候補から選出されたID

  // チームスコア管理
  teamAScore: number;
  teamBScore: number;

  // チーム役割管理
  teamARole: Role;
  teamBRole: Role;

  // イベントログ
  logs: GameLog[];

  // 汎用ルール可変設定
  victoryMode?: VictoryMode;
  shinkansenMaxMinutes?: number;
  shinkansenMaxSegments?: number;
  postShinkansenWaitMinutes?: number;
  periodicRevealIntervalMinutes?: number;
  periodicRevealDurationMinutes?: number;
  captureWaitMinutes?: number;
  missionPenaltyRevealMinutes?: number;

  lastCaptureTargetId?: string;
  locationRevealUntil?: number;
  teamARevealUntil?: number;
  teamBRevealUntil?: number;
  nextRevealTime?: number;
  gameSessionId?: string;
  sessionStartedAt?: number;
  sessionSchemaVersion?: number;
}


export interface MissionCompletion {
  gameSessionId: string;
  missionId: string;
  team: 'A' | 'B';
  completedBy: string;
  points: number;
  luckyReward: boolean;
  isFinalMission: boolean;
  completedAt: unknown;
}

export interface LocationLog {
  userId: string;
  lat: number;
  lng: number;
  timestamp: number;
}