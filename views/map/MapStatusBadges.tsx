import type React from 'react';
import { Shield, Train } from 'lucide-react';
import type { MapTimeLeft } from '../../src/game';
import type { User } from '../../types';

interface MapStatusBadgesProps {
  currentUser: User;
  timeLeft: MapTimeLeft;
  formatTime: (sec: number) => string;
}

const MapStatusBadges: React.FC<MapStatusBadgesProps> = ({
  currentUser,
  timeLeft,
  formatTime,
}) => (
  <div className="absolute top-16 left-4 z-[1000] flex flex-col gap-2 pointer-events-none">
    {currentUser.lastStation && (
      <div className="bg-slate-900/95 backdrop-blur text-blue-400 px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg border border-slate-700/60 flex items-center gap-1.5">
        <Train size={12} className="text-blue-400 shrink-0" />
        <span className="text-slate-200 truncate max-w-[140px]">{currentUser.lastStation}</span>
      </div>
    )}
    {currentUser.protectionZone && currentUser.protectionZone !== 'NONE' && (
      <div className="bg-emerald-600 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg flex items-center gap-1">
        <Shield size={12} /> {currentUser.protectionZone === 'GREEN_CAR' ? 'グリーン席保護中' : 'セーフゾーン中'}
      </div>
    )}
    {timeLeft.invincible > 0 && (
      <div className="bg-amber-500 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg">
        無敵中: {formatTime(timeLeft.invincible)}
      </div>
    )}
    {timeLeft.waiting > 0 && (
      <div className="bg-slate-900 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg">
        待機中: {formatTime(timeLeft.waiting)}
      </div>
    )}
    {timeLeft.shinkansenRemaining > 0 && currentUser.status === 'ACTIVE' && (
      <div className="bg-blue-600 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg flex items-center gap-1">
        <Train size={12} /> 新幹線移動: {formatTime(timeLeft.shinkansenRemaining)}
      </div>
    )}
  </div>
);

export default MapStatusBadges;
