import type React from 'react';
import { Train } from 'lucide-react';
import { toast } from 'sonner';
import { DEFAULT_DYNAMIC_RULE_SETTINGS } from '../../constants';
import { isGameActive, type MapTimeLeft } from '../../src/game';
import type { GameConfig, ProtectionZoneType, User } from '../../types';

interface MapRunnerControlsProps {
  currentUser: User;
  gameConfig: GameConfig;
  timeLeft: MapTimeLeft;
  nowMs: number;
  isProcessing: boolean;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  formatTime: (sec: number) => string;
  onActivateInvincibility: () => Promise<void>;
  onStartShinkansenWait: () => Promise<void>;
  onUpdateProtectionZone?: (zone: ProtectionZoneType) => Promise<void>;
  onStartShinkansen?: () => Promise<void>;
  onIncrementShinkansenSegment?: () => Promise<void>;
  onResetShinkansen?: () => Promise<void>;
}

const MapRunnerControls: React.FC<MapRunnerControlsProps> = ({
  currentUser,
  gameConfig,
  timeLeft,
  nowMs,
  isProcessing,
  setIsProcessing,
  formatTime,
  onActivateInvincibility,
  onStartShinkansenWait,
  onUpdateProtectionZone,
  onStartShinkansen,
  onIncrementShinkansenSegment,
  onResetShinkansen,
}) => {
  const isRunnerReady = currentUser.status === 'ACTIVE' && isGameActive(gameConfig.gameStatus);
  const canUseInvincibility =
    !isProcessing &&
    isRunnerReady &&
    (currentUser.invincibleCards ?? 0) > 0 &&
    timeLeft.invincible <= 0;

  const maxMinutes = gameConfig.shinkansenMaxMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxMinutes;
  const maxSegments = gameConfig.shinkansenMaxSegments ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxSegments;
  const isShinkansenTimeReached = maxMinutes > 0 && timeLeft.shinkansenRemaining <= 0;
  const isShinkansenSegmentReached = maxSegments > 0 && (currentUser.shinkansenSegmentCount ?? 0) >= maxSegments;
  const canResetShinkansen = Boolean(
    onResetShinkansen &&
    currentUser.shinkansenStartTime &&
    nowMs - currentUser.shinkansenStartTime <= 60_000 &&
    (currentUser.shinkansenSegmentCount ?? 0) === 0,
  );

  const handleAction = async (fn: (() => Promise<void>) | undefined, showFailureToast = false) => {
    if (!fn) return;
    setIsProcessing(true);
    try {
      await fn();
    } catch {
      if (showFailureToast) toast.error('失敗しました');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="w-full max-w-sm flex flex-col items-center gap-2">
      {/* 特例保護エリア切り替えセレクター */}
      <div className="w-full flex items-center justify-between gap-1.5 bg-white/95 backdrop-blur-md px-3 py-2 rounded-2xl border border-slate-200 shadow-xl">
        <span className="text-[10px] font-black text-slate-500 shrink-0">特例保護:</span>
        <div className="flex gap-1">
          <button
            type="button"
            disabled={isProcessing || !isRunnerReady}
            onClick={() => { void handleAction(() => onUpdateProtectionZone?.('NONE') ?? Promise.resolve()); }}
            className={`px-2.5 py-1 rounded-xl text-xs font-bold transition-all disabled:opacity-50 ${
              (!currentUser.protectionZone || currentUser.protectionZone === 'NONE')
                ? 'bg-slate-800 text-white shadow-sm'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            通常
          </button>
          <button
            type="button"
            disabled={isProcessing || !isRunnerReady}
            onClick={() => { void handleAction(() => onUpdateProtectionZone?.('GREEN_CAR') ?? Promise.resolve()); }}
            className={`px-2.5 py-1 rounded-xl text-xs font-bold transition-all disabled:opacity-50 ${
              currentUser.protectionZone === 'GREEN_CAR'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            🛡️ グリーン席
          </button>
          <button
            type="button"
            disabled={isProcessing || !isRunnerReady}
            onClick={() => { void handleAction(() => onUpdateProtectionZone?.('SAFE_ZONE') ?? Promise.resolve()); }}
            className={`px-2.5 py-1 rounded-xl text-xs font-bold transition-all disabled:opacity-50 ${
              currentUser.protectionZone === 'SAFE_ZONE'
                ? 'bg-teal-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            🛡️ セーフゾーン
          </button>
        </div>
      </div>

      {/* 新幹線乗車中 HUD 兼 アクション */}
      {currentUser.shinkansenStartTime ? (
        <div className="flex flex-col gap-2 w-full">
          {(isShinkansenTimeReached || isShinkansenSegmentReached) && (
            <div className="bg-red-600 text-white text-[11px] font-bold p-2.5 rounded-2xl text-center shadow-lg animate-pulse">
              ⚠️ 新幹線利用上限（{maxMinutes > 0 ? `最長${maxMinutes}分` : '時間無制限'}{maxSegments > 0 ? ` / 最大${maxSegments}区間` : ''}）に達しました！速やかに下車してください。
            </div>
          )}
          <div className="bg-slate-900/95 backdrop-blur-md text-white p-3 rounded-2xl flex items-center justify-between shadow-xl border border-slate-700">
            <div className="flex items-center gap-2">
              <Train size={20} className="text-blue-400 animate-pulse" />
              <div>
                <div className="text-[10px] font-bold text-slate-400">🚄 新幹線乗車中</div>
                <div className="text-xs font-black">
                  残り: <span className="font-mono text-amber-400">{maxMinutes > 0 ? formatTime(timeLeft.shinkansenRemaining) : '無制限'}</span>
                  {' / '}
                  <span>{currentUser.shinkansenSegmentCount ?? 0} / {maxSegments > 0 ? `${maxSegments} 区間` : '無制限'}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => { void handleAction(onIncrementShinkansenSegment); }}
                disabled={isProcessing || !isRunnerReady}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl active:scale-95 shadow transition-all disabled:opacity-50"
              >
                +1区間
              </button>
              {canResetShinkansen && (
                <button
                  type="button"
                  onClick={() => { void handleAction(onResetShinkansen); }}
                  disabled={isProcessing || !isRunnerReady}
                  className="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-bold rounded-xl active:scale-95 shadow transition-all disabled:opacity-50"
                  title="新幹線乗車を取消（開始60秒以内のみ）"
                >
                  取消(60秒以内)
                </button>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { void handleAction(onActivateInvincibility, true); }}
              disabled={!canUseInvincibility}
              className="px-4 py-3 bg-amber-500 text-white rounded-2xl font-bold text-sm shadow-xl disabled:bg-slate-100 disabled:text-slate-400 active:scale-95 transition-all"
            >
              無敵 ({currentUser.invincibleCards ?? 0})
            </button>
            <button
              type="button"
              onClick={() => { void handleAction(onStartShinkansenWait, true); }}
              disabled={isProcessing || !isRunnerReady}
              className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-2xl font-black text-sm shadow-xl disabled:bg-slate-100 disabled:text-slate-400 active:scale-95 transition-all"
            >
              下車待機（{gameConfig.postShinkansenWaitMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.postShinkansenWaitMinutes}分）開始
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 w-full justify-center">
          <button
            type="button"
            onClick={() => { void handleAction(onActivateInvincibility, true); }}
            disabled={!canUseInvincibility}
            className="px-4 py-3 bg-amber-500 text-white rounded-2xl font-bold text-sm shadow-xl disabled:bg-slate-100 disabled:text-slate-400 active:scale-95 transition-all"
          >
            無敵カード ({currentUser.invincibleCards ?? 0})
          </button>
          <button
            type="button"
            onClick={() => { void handleAction(onStartShinkansen); }}
            disabled={isProcessing || !isRunnerReady}
            className="px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-bold text-sm shadow-xl disabled:bg-slate-100 disabled:text-slate-400 active:scale-95 transition-all flex items-center gap-1.5"
          >
            <Train size={16} /> 新幹線乗車開始
          </button>
          <button
            type="button"
            onClick={() => { void handleAction(onStartShinkansenWait, true); }}
            disabled={isProcessing || !isRunnerReady || timeLeft.shinkansenRemaining > 0}
            className="px-4 py-3 bg-white text-slate-700 rounded-2xl font-bold text-sm shadow-xl border border-slate-200 disabled:bg-slate-50 active:scale-95 transition-all"
          >
            待機
          </button>
        </div>
      )}
    </div>
  );
};

export default MapRunnerControls;
