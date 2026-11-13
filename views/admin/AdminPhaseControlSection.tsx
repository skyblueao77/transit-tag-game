import type React from 'react';
import { Play } from 'lucide-react';
import type { GameStatus } from '../../types';

export type PhaseControlAction =
  | 'START_DAY1'
  | 'PAUSE'
  | 'RESUME'
  | 'END_DAY1'
  | 'START_DAY2'
  | 'START_FINAL'
  | 'END_GAME';

interface AdminPhaseControlSectionProps {
  gameStatus: GameStatus;
  phaseLabel: string;
  isProcessing: boolean;
  onPhaseAction: (action: PhaseControlAction) => void;
}

const AdminPhaseControlSection: React.FC<AdminPhaseControlSectionProps> = ({
  gameStatus,
  phaseLabel,
  isProcessing,
  onPhaseAction,
}) => {
  return (
    <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-black flex items-center gap-2 text-slate-800 uppercase tracking-tight text-sm">
          <Play size={18} className="text-blue-600" />
          進行コントロール
        </h3>
        <span className="text-xs font-black px-3 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-100">
          {phaseLabel}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {gameStatus === 'PRE_GAME' && (
          <button
            type="button"
            onClick={() => onPhaseAction('START_DAY1')}
            disabled={isProcessing}
            className="col-span-2 py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-black text-sm shadow-lg flex items-center justify-center gap-2 active:scale-95 transition-all"
          >
            <Play size={18} /> DAY 1（ゲーム本戦）を開始する
          </button>
        )}

        {gameStatus === 'DAY1_ACTIVE' && (
          <>
            <button type="button" onClick={() => onPhaseAction('PAUSE')} disabled={isProcessing} className="p-3.5 rounded-xl font-black text-xs bg-slate-100 text-slate-700 hover:bg-slate-200">
              ⏸ 一時停止
            </button>
            <button type="button" onClick={() => onPhaseAction('END_DAY1')} disabled={isProcessing} className="p-3.5 rounded-xl font-black text-xs bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200">
              🌙 DAY 1 終了（宿へ）
            </button>
            <button type="button" onClick={() => onPhaseAction('START_FINAL')} disabled={isProcessing} className="col-span-2 py-3.5 bg-gradient-to-r from-red-600 to-amber-600 text-white rounded-xl font-black text-xs shadow-md flex items-center justify-center gap-1.5">
              🔥 最終ミッション開始（1日制クライマックス）
            </button>
            <button type="button" onClick={() => onPhaseAction('END_GAME')} disabled={isProcessing} className="col-span-2 py-2.5 bg-slate-800 text-white rounded-xl font-bold text-xs">
              🏁 ゲーム終了・結果発表へ
            </button>
          </>
        )}

        {gameStatus === 'DAY1_PAUSED' && (
          <>
            <button type="button" onClick={() => onPhaseAction('RESUME')} disabled={isProcessing} className="col-span-2 py-3.5 bg-emerald-600 text-white rounded-xl font-black text-xs shadow-md">
              ▶ DAY 1 を再開する
            </button>
            <button type="button" onClick={() => onPhaseAction('START_FINAL')} disabled={isProcessing} className="p-3 bg-red-600 text-white rounded-xl font-bold text-xs">
              🔥 最終ミッションへ
            </button>
            <button type="button" onClick={() => onPhaseAction('END_GAME')} disabled={isProcessing} className="p-3 bg-slate-800 text-white rounded-xl font-bold text-xs">
              🏁 結果発表へ
            </button>
          </>
        )}

        {gameStatus === 'DAY1_ENDED' && (
          <>
            <button type="button" onClick={() => onPhaseAction('START_DAY2')} disabled={isProcessing} className="col-span-2 py-3.5 bg-blue-600 text-white rounded-2xl font-black text-sm shadow-md">
              ☀️ DAY 2 を開始する（2日目）
            </button>
            <button type="button" onClick={() => onPhaseAction('START_FINAL')} disabled={isProcessing} className="p-3 bg-red-600 text-white rounded-xl font-black text-xs">
              🔥 最終ミッションを実施
            </button>
            <button type="button" onClick={() => onPhaseAction('END_GAME')} disabled={isProcessing} className="p-3 bg-slate-800 text-white rounded-xl font-bold text-xs">
              🏁 ゲーム終了（結果発表）
            </button>
          </>
        )}

        {gameStatus === 'DAY2_ACTIVE' && (
          <>
            <button type="button" onClick={() => onPhaseAction('PAUSE')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-xs bg-slate-100 text-slate-700">
              ⏸ 一時停止
            </button>
            <button type="button" onClick={() => onPhaseAction('START_FINAL')} disabled={isProcessing} className="p-3 bg-red-600 text-white rounded-xl font-black text-xs shadow-md">
              🔥 最終ミッション開始
            </button>
            <button type="button" onClick={() => onPhaseAction('END_GAME')} disabled={isProcessing} className="col-span-2 py-2.5 bg-slate-800 text-white rounded-xl font-bold text-xs">
              🏁 結果発表へ
            </button>
          </>
        )}

        {gameStatus === 'DAY2_PAUSED' && (
          <>
            <button type="button" onClick={() => onPhaseAction('RESUME')} disabled={isProcessing} className="col-span-2 py-3 bg-blue-600 text-white rounded-xl font-black text-xs">
              ▶ DAY 2 再開
            </button>
            <button type="button" onClick={() => onPhaseAction('START_FINAL')} disabled={isProcessing} className="p-3 bg-red-600 text-white rounded-xl font-bold text-xs">
              🔥 最終ミッションへ
            </button>
            <button type="button" onClick={() => onPhaseAction('END_GAME')} disabled={isProcessing} className="p-3 bg-slate-800 text-white rounded-xl font-bold text-xs">
              🏁 結果発表へ
            </button>
          </>
        )}

        {gameStatus === 'FINAL_MISSION' && (
          <button
            type="button"
            onClick={() => onPhaseAction('END_GAME')}
            disabled={isProcessing}
            className="col-span-2 py-4 bg-red-600 text-white rounded-2xl font-black text-sm shadow-xl active:scale-95"
          >
            🏁 全工程終了・結果発表を表示
          </button>
        )}

        {gameStatus === 'GAME_OVER' && (
          <div className="col-span-2 p-3 bg-slate-100 rounded-xl text-center text-xs font-bold text-slate-600">
            全行程終了済み。下部のマスターリセットから新しいセッションを開始できます。
          </div>
        )}
      </div>
    </section>
  );
};

export default AdminPhaseControlSection;
