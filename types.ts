import { Timestamp, FieldValue } from 'firebase/firestore';
import type { GameStatus, Role } from './src/game/types';

export type { GameStatus, Role } from './src/game/types';

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


  status: 'ACTIVE' | 'CAPTURED' | 'WAITING' | 'EMERGENCY' | 'RETIRED';
  invincibleUntil?: number;
  waitingUntil?: number;
  invincibleCards: number;
  lastStation?: string;
  shinkansenStartTime?: number;
}

export interface PrivateLocation {
  latitude: number;
  longitude: number;
  updatedAt?: unknown;
}

export interface ExposedLocation {
  latitude: number;
  longitude: number;
  capturedAt?: unknown;
  expiresAt: number;
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

  locationRevealUntil?: number;
  teamARevealUntil?: number;
  teamBRevealUntil?: number;
  nextRevealTime?: number;
}

export interface LocationLog {
  userId: string;
  lat: number;
  lng: number;
  timestamp: number;
}