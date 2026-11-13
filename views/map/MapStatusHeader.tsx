import type React from 'react';
import { AlertCircle, Clock, MapPin, WifiOff } from 'lucide-react';
import { DEFAULT_DYNAMIC_RULE_SETTINGS } from '../../constants';
import { formatDistanceMeters, type MapTimeLeft } from '../../src/game';
import type { GameConfig } from '../../types';

interface MapStatusHeaderProps {
  isOffline: boolean;
  timeLeft: MapTimeLeft;
  gameConfig: GameConfig;
  isTeamSplitAlert: boolean;
  maxTeammateDistance: number;
  formatTime: (sec: number) => string;
}

const MapStatusHeader: React.FC<MapStatusHeaderProps> = ({
  isOffline,
  timeLeft,
  gameConfig,
  isTeamSplitAlert,
  maxTeammateDistance,
  formatTime,
}) => (
  <>
    {isOffline && (
      <div className="z-[1002] bg-orange-600 text-white text-[10px] font-black py-1 px-4 flex items-center justify-center gap-2">
        <WifiOff size={12} /> 通信断：位置更新を一時停止中
      </div>
    )}

    {timeLeft.penaltyRemaining > 0 ? (
      <div className="z-[1001] px-4 py-2 bg-red-700 text-white text-center text-xs font-black animate-pulse flex items-center justify-center gap-2">
        <AlertCircle size={14} /> 🚨 【ペナルティ】位置情報常時公開中！ 残り {formatTime(timeLeft.penaltyRemaining)}
      </div>
    ) : timeLeft.teamSearchRemaining > 0 ? (
      <div className="z-[1001] px-4 py-2 bg-red-600 text-white text-center text-xs font-black animate-pulse flex items-center justify-center gap-2">
        <AlertCircle size={14} /> 【警告】チーム位置スナップショット公開中！ 残り {formatTime(timeLeft.teamSearchRemaining)}
      </div>
    ) : timeLeft.forceReveal > 0 ? (
      <div className="z-[1001] px-4 py-2 bg-amber-500 text-white text-center text-xs font-black flex items-center justify-center gap-2">
        <MapPin size={14} /> 管理者による位置強制公開中！ 残り {formatTime(timeLeft.forceReveal)}
      </div>
    ) : timeLeft.nextReveal > 0 ? (
      <div className="z-[1001] px-4 py-2 bg-indigo-600 text-white text-center text-xs font-black flex items-center justify-center gap-2">
        <Clock size={14} /> 次の位置公開まで {formatTime(timeLeft.nextReveal)}（開示: {gameConfig.periodicRevealDurationMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealDurationMinutes}分間 / 間隔: {gameConfig.periodicRevealIntervalMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealIntervalMinutes}分）
      </div>
    ) : gameConfig.isFinalMissionActive ? (
      <div className="z-[1001] px-4 py-2 bg-slate-900 text-red-500 text-center text-xs font-black animate-pulse flex items-center justify-center gap-2 border-b border-red-500/50">
        <AlertCircle size={14} /> 最終ミッション発動中！ 残り {Math.floor(timeLeft.final / 60)}分
      </div>
    ) : null}

    {isTeamSplitAlert && (
      <div className="z-[1001] px-4 py-1.5 bg-amber-600 text-white text-center text-xs font-black flex items-center justify-center gap-2">
        <AlertCircle size={14} /> 【同一行動規定】チームメンバーと離れすぎています（約{formatDistanceMeters(maxTeammateDistance)}）。単独行動・挟み撃ちは禁止です。
      </div>
    )}
  </>
);

export default MapStatusHeader;
