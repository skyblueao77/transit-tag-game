import type React from 'react';
import { AlertTriangle, MapPin } from 'lucide-react';
import type { GameConfig, User } from '../../types';
import type { AdminRevealScope } from '../../src/game/adminReveal';
import { getPlayerRole } from '../../src/game';

interface AdminLocationRevealSectionProps {
  config: GameConfig;
  users: User[];
  searchDuration: number;
  penaltyTargetPlayerId: string;
  penaltyDurationMinutes: number;
  isProcessing: boolean;
  isApplyingPenalty: boolean;
  onChangeSearchDuration: (minutes: number) => void;
  onLocationReveal: (scope: AdminRevealScope) => void;
  onChangePenaltyTargetPlayerId: (playerId: string) => void;
  onChangePenaltyDurationMinutes: (minutes: number) => void;
  onApplyPenalty: () => void;
}

const AdminLocationRevealSection: React.FC<AdminLocationRevealSectionProps> = ({
  config,
  users,
  searchDuration,
  penaltyTargetPlayerId,
  penaltyDurationMinutes,
  isProcessing,
  isApplyingPenalty,
  onChangeSearchDuration,
  onLocationReveal,
  onChangePenaltyTargetPlayerId,
  onChangePenaltyDurationMinutes,
  onApplyPenalty,
}) => {
  const participants = users.filter(u => u.team === 'A' || u.team === 'B');

  return (
    <section className="bg-amber-500 p-6 rounded-3xl shadow-xl text-white">
      <h3 className="font-black flex items-center gap-2 mb-3 uppercase tracking-tight text-sm">
        <MapPin size={18} /> 位置強制公開（スナップショット）
      </h3>
      <div className="space-y-3">
        <div className="bg-white/10 p-3 rounded-2xl border border-white/20 flex items-center justify-between">
          <span className="text-xs font-bold">公開時間（分）</span>
          <input
            type="number"
            min={1}
            max={30}
            value={searchDuration}
            onChange={e => onChangeSearchDuration(Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 1)))}
            className="w-16 bg-white text-amber-700 font-black p-1.5 rounded-lg text-center text-xs"
          />
        </div>
        <button
          type="button"
          onClick={() => onLocationReveal('GLOBAL')}
          disabled={isProcessing}
          className="w-full py-3.5 bg-white text-amber-700 rounded-2xl font-black text-sm shadow-md active:scale-95"
        >
          全員の現在地を公開
        </button>
        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/20">
          <button
            type="button"
            onClick={() => onLocationReveal('TEAM_A')}
            disabled={isProcessing}
            className="py-2.5 bg-red-600 text-white rounded-xl font-bold text-xs shadow-md border border-white/10"
          >
            Team A のみ公開
          </button>
          <button
            type="button"
            onClick={() => onLocationReveal('TEAM_B')}
            disabled={isProcessing}
            className="py-2.5 bg-blue-600 text-white rounded-xl font-bold text-xs shadow-md border border-white/10"
          >
            Team B のみ公開
          </button>
        </div>

        {/* 特定プレイヤーへのミッション違反・ルール違反ペナルティ発動 */}
        <div className="pt-3 border-t border-white/20">
          <h4 className="text-xs font-black flex items-center gap-1.5 mb-1 text-white">
            <AlertTriangle size={14} className="text-yellow-300" />
            ミッション違反・個別ペナルティ発動（位置常時公開）
          </h4>
          <p className="text-[10px] text-amber-100 mb-2 leading-relaxed">
            ミッション不参加や禁止交通機関利用などの違反者に対して、指定時間位置情報を常時開示します。
          </p>
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
            <select
              value={penaltyTargetPlayerId}
              onChange={e => onChangePenaltyTargetPlayerId(e.target.value)}
              className="flex-1 min-w-[180px] bg-white text-slate-800 text-xs font-bold p-2.5 rounded-xl border border-amber-300"
            >
              <option value="">対象プレイヤーを選択...</option>
              {participants.map(u => {
                const effectiveRole = getPlayerRole(u, config);
                return (
                  <option key={u.id} value={u.id}>
                    {u.name} (Team {u.team} - {effectiveRole})
                  </option>
                );
              })}
            </select>
            <div className="flex items-center gap-1.5 bg-white/10 px-3 py-1.5 rounded-xl border border-white/20">
              <span className="text-[11px] font-bold text-white whitespace-nowrap">時間(分):</span>
              <input
                type="number"
                min={1}
                max={180}
                value={penaltyDurationMinutes}
                onChange={e => onChangePenaltyDurationMinutes(Math.min(180, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                className="w-16 bg-white text-amber-800 text-xs font-black p-1.5 rounded-lg text-center"
              />
            </div>
            <button
              type="button"
              onClick={onApplyPenalty}
              disabled={isApplyingPenalty || !penaltyTargetPlayerId}
              className="py-2.5 px-4 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-black shadow-md active:scale-95 transition-all disabled:opacity-50 whitespace-nowrap"
            >
              {isApplyingPenalty ? '発動中...' : '🚨 ペナルティ発動'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default AdminLocationRevealSection;
