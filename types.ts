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
  lastLat: number; // 常に更新される真の現在地（距離判定に使用）
  lastLng: number; // 常に更新される真の現在地（距離判定に使用）

  /** * 位置公開スナップショット仕様 
   * リアルタイムの移動を隠すため、公開ボタンが押された瞬間の座標をここにコピーします。
   */
  exposedLat?: number;           // 公開された瞬間の緯度（固定）
  exposedLng?: number;           // 公開された瞬間の経度（固定）
  locationExposedUntil?: number; // 公開が終了する時刻 (Date.now() + 5分)

  /**
   * lastUpdate は Firestoreから取得時は Timestamp オブジェクト、
   * 書き込み時は FieldValue (serverTimestamp) または number が入るため any で許容します。
   */
  lastUpdate: any;
  status: 'ACTIVE' | 'CAPTURED' | 'WAITING' | 'EMERGENCY' | 'RETIRED';
  invincibleUntil?: number;
  waitingUntil?: number;
  invincibleCards: number;
  lastStation?: string;
  shinkansenStartTime?: number;
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