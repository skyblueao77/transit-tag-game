import type React from 'react';
import { useState } from 'react';
import { Train, Check, ChevronDown, X, MapPin } from 'lucide-react';
import type { TransitSuggestion } from '../game/stationInference';

interface Props {
  suggestion: TransitSuggestion | null;
  candidates: TransitSuggestion[];
  currentLastStation?: string;
  onConfirmStation: (stationName: string) => Promise<void>;
  onDismiss?: () => void;
}

export const StationSuggestCard: React.FC<Props> = ({
  suggestion,
  candidates,
  currentLastStation,
  onConfirmStation,
  onDismiss,
}) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  if (!suggestion) return null;

  const isAlreadySet = currentLastStation === suggestion.displayText;
  if (isAlreadySet) return null;

  const handleConfirm = async (text: string) => {
    setIsUpdating(true);
    try {
      await onConfirmStation(text);
      setShowDropdown(false);
    } finally {
      setIsUpdating(false);
    }
  };

  const isInTransit = suggestion.proximity === 'IN_TRANSIT';
  const isAtStation = suggestion.proximity === 'AT_STATION';

  const badgeText = isInTransit
    ? '走行中の区間を推定'
    : isAtStation
      ? '駅を検出'
      : '最寄り駅の提案';

  const badgeIcon = isInTransit || isAtStation ? <Train size={16} /> : <MapPin size={16} />;

  return (
    <aside
      aria-label="現在地の提案"
      className="pointer-events-auto w-full max-w-sm mx-auto bg-slate-900/95 backdrop-blur-md text-white rounded-2xl shadow-2xl border border-slate-700/80 p-3 flex flex-col gap-2 transition-all animate-in fade-in slide-in-from-top-4 duration-300"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
              isInTransit
                ? 'bg-emerald-600 text-white animate-pulse'
                : isAtStation
                  ? 'bg-blue-600 text-white animate-pulse'
                  : 'bg-slate-800 text-slate-300'
            }`}
          >
            {badgeIcon}
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-black uppercase tracking-wider text-blue-400 flex items-center gap-1.5">
              <span>{badgeText}</span>
              <span className="text-slate-400 font-mono font-normal">({suggestion.formattedDistance})</span>
            </div>
            <div className="text-xs font-black truncate text-white" title={suggestion.displayText}>
              {suggestion.displayText}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => handleConfirm(suggestion.displayText)}
            disabled={isUpdating}
            className="flex items-center gap-1 bg-blue-600 hover:bg-blue-500 active:scale-95 disabled:opacity-50 text-white text-[11px] font-bold px-3 py-1.5 rounded-xl shadow transition-all cursor-pointer"
          >
            <Check size={13} />
            <span>設定</span>
          </button>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="提案を閉じる"
              className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {candidates.length > 1 && (
        <div className="pt-1 border-t border-slate-800/80 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setShowDropdown(prev => !prev)}
            className="flex items-center justify-between text-[10px] text-slate-400 hover:text-slate-200 transition-colors py-0.5 cursor-pointer"
          >
            <span>他の候補 ({candidates.length}件)</span>
            <ChevronDown
              size={12}
              className={`transition-transform duration-200 ${showDropdown ? 'rotate-180' : ''}`}
            />
          </button>

          {showDropdown && (
            <div className="flex flex-col gap-1 mt-1 max-h-40 overflow-y-auto">
              {candidates.map(candidate => (
                <button
                  key={`${candidate.type}_${candidate.displayText}`}
                  type="button"
                  onClick={() => handleConfirm(candidate.displayText)}
                  disabled={isUpdating}
                  className="flex items-center justify-between text-left text-[11px] py-1.5 px-2 rounded-lg bg-slate-800/60 hover:bg-slate-800 active:bg-blue-900/40 text-slate-200 transition-colors cursor-pointer"
                >
                  <span className="truncate pr-2">
                    {candidate.proximity === 'IN_TRANSIT' ? '🚆 ' : '📍 '}
                    {candidate.displayText}
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-400 font-mono">
                    {candidate.formattedDistance}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
};

export default StationSuggestCard;
