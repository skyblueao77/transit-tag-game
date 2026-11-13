import type React from 'react';
import { isGameActive } from '../../src/game';
import type { GameConfig, User } from '../../types';

interface MapOniCapturePanelProps {
  currentUser: User;
  gameConfig: GameConfig;
  captureCandidates: User[];
  selectedTargetId: string;
  isProcessing: boolean;
  onSelectTarget: (targetId: string) => void;
  onCapture: (targetId: string) => Promise<void>;
}

const MapOniCapturePanel: React.FC<MapOniCapturePanelProps> = ({
  currentUser,
  gameConfig,
  captureCandidates,
  selectedTargetId,
  isProcessing,
  onSelectTarget,
  onCapture,
}) => {
  const selectedTarget = captureCandidates.find(user => user.id === selectedTargetId);
  const isSelectedTargetProtected = Boolean(
    selectedTarget?.protectionZone &&
    selectedTarget.protectionZone !== 'NONE',
  );
  const isCaptureDisabled =
    isProcessing ||
    !selectedTargetId ||
    captureCandidates.length === 0 ||
    currentUser.status !== 'ACTIVE' ||
    !isGameActive(gameConfig.gameStatus) ||
    isSelectedTargetProtected;

  return (
    <div className="w-full max-w-sm flex flex-col gap-2">
      <label className="text-xs font-bold text-slate-600 text-center" htmlFor="capture-target">
        捕獲対象
      </label>
      <select
        id="capture-target"
        value={selectedTargetId}
        onChange={event => onSelectTarget(event.target.value)}
        disabled={isProcessing || captureCandidates.length === 0}
        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold shadow-xl disabled:bg-slate-100"
      >
        {captureCandidates.length === 0 ? (
          <option value="">捕獲可能な逃走者はいません</option>
        ) : (
          captureCandidates.map(user => {
            const isProtected = user.protectionZone && user.protectionZone !== 'NONE';
            const tag = isProtected
              ? ` [🛡️ ${user.protectionZone === 'GREEN_CAR' ? 'グリーン席保護' : 'セーフゾーン'}]`
              : '';
            return (
              <option key={user.id} value={user.id}>
                {user.name}{tag}
              </option>
            );
          })
        )}
      </select>
      <button
        type="button"
        onClick={onCapture.bind(null, selectedTargetId)}
        disabled={isCaptureDisabled}
        className={`px-10 py-4 rounded-full font-black text-lg shadow-2xl transition-all ${
          isCaptureDisabled
            ? 'bg-slate-400 text-white cursor-not-allowed'
            : 'bg-slate-900 text-white active:scale-95'
        }`}
      >
        {isSelectedTargetProtected ? '🛡️ 特例保護エリア宣言中のため捕獲不可' : '捕獲ボタン'}
      </button>
    </div>
  );
};

export default MapOniCapturePanel;
