import type React from 'react';
import { Trophy } from 'lucide-react';
import type { GameConfig } from '../../types';
import type { AdjustTeamScoreResult, ScoreAdjustmentReasonCode } from '../../src/application/gameplayPorts';

interface AdminScoreAdjustmentSectionProps {
  config: GameConfig;
  scoreTeam: 'A' | 'B';
  onChangeScoreTeam: (team: 'A' | 'B') => void;
  scoreDeltaInput: string;
  onChangeScoreDeltaInput: (val: string) => void;
  scoreReasonCode: ScoreAdjustmentReasonCode;
  onChangeScoreReasonCode: (code: ScoreAdjustmentReasonCode) => void;
  isProcessing: boolean;
  onAdjustTeamScore: () => Promise<void>;
  scoreAdjustmentResult: Extract<AdjustTeamScoreResult, { ok: true }> | null;
}

const AdminScoreAdjustmentSection: React.FC<AdminScoreAdjustmentSectionProps> = ({
  config,
  scoreTeam,
  onChangeScoreTeam,
  scoreDeltaInput,
  onChangeScoreDeltaInput,
  scoreReasonCode,
  onChangeScoreReasonCode,
  isProcessing,
  onAdjustTeamScore,
  scoreAdjustmentResult,
}) => (
  <section className="bg-white p-5 rounded-3xl shadow-sm border border-slate-200">
    <h3 className="font-black mb-3 flex items-center gap-2 text-slate-800 text-sm uppercase">
      <Trophy size={18} className="text-amber-500" />
      スコア手動補正
    </h3>
    <div className="grid grid-cols-2 gap-3 mb-3">
      {(['A', 'B'] as const).map(t => (
        <div key={t} className="p-3 bg-slate-50 rounded-2xl border border-slate-100 text-center">
          <div className="text-[10px] font-black text-slate-400 uppercase">Team {t}</div>
          <div className="text-xl font-black text-slate-900">{t === 'A' ? (config.teamAScore ?? 0) : (config.teamBScore ?? 0)} <span className="text-xs">pt</span></div>
        </div>
      ))}
    </div>
    <div className="grid grid-cols-2 gap-2">
      <select value={scoreTeam} onChange={e => onChangeScoreTeam(e.target.value as 'A' | 'B')} className="p-2 border rounded-xl text-xs font-bold text-slate-800">
        <option value="A">Team A</option>
        <option value="B">Team B</option>
      </select>
      <input
        type="number"
        value={scoreDeltaInput}
        onChange={e => onChangeScoreDeltaInput(e.target.value)}
        className="p-2 border rounded-xl text-xs font-bold text-slate-800"
        placeholder="増減値 (例: 10 / -5)"
      />
    </div>
    <div className="mt-2">
      <label htmlFor="score-reason-select" className="block text-[10px] font-black text-slate-500 mb-1">補正理由</label>
      <select
        id="score-reason-select"
        value={scoreReasonCode}
        onChange={e => onChangeScoreReasonCode(e.target.value as ScoreAdjustmentReasonCode)}
        className="w-full p-2 border rounded-xl text-xs font-bold text-slate-800"
      >
        <option value="CORRECTION">スコア訂正</option>
        <option value="BONUS">運営ボーナス</option>
        <option value="PENALTY">運営ペナルティ</option>
        <option value="OTHER">その他の運営調整</option>
      </select>
    </div>
    <button
      type="button"
      onClick={() => void onAdjustTeamScore()}
      disabled={isProcessing}
      className="mt-2 w-full py-2.5 bg-indigo-600 text-white rounded-xl font-black text-xs disabled:opacity-50"
    >
      スコアを補正する
    </button>
    {scoreAdjustmentResult && (
      <p role="status" className="mt-2 text-center text-xs font-bold text-emerald-700">
        Team {scoreAdjustmentResult.team}: {scoreAdjustmentResult.previousScore} → {scoreAdjustmentResult.nextScore} pt
      </p>
    )}
  </section>
);

export default AdminScoreAdjustmentSection;
