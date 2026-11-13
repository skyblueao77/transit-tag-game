import type React from 'react';
import { History, LogOut, Trophy } from 'lucide-react';
import type { GameLog } from '../../../types';
import type { SafetyAction, SafetyReasonCode } from '../../game/playerSafety';
import SafetyActionDialog from './SafetyActionDialog';

interface FinalResultViewProps {
  winner: 'A' | 'B' | 'DRAW';
  aScore: number;
  bScore: number;
  logs: GameLog[];
  safetyDialogOpen: boolean;
  safetyActionBusy: boolean;
  onOpenSafetyDialog: () => void;
  onCloseSafetyDialog: () => void;
  onChooseSafetyAction: (action: SafetyAction, reasonCode: SafetyReasonCode) => Promise<void>;
  onSignOutAndReload: () => Promise<void>;
}

const FinalResultView: React.FC<FinalResultViewProps> = ({
  winner,
  aScore,
  bScore,
  logs,
  safetyDialogOpen,
  safetyActionBusy,
  onOpenSafetyDialog,
  onCloseSafetyDialog,
  onChooseSafetyAction,
  onSignOutAndReload,
}) => (
  <div className="min-h-screen bg-slate-900 text-white p-6 flex flex-col items-center overflow-y-auto">
    <Trophy size={80} className="text-amber-500 mb-6 animate-bounce" />
    <h1 className="text-4xl font-black italic mb-2">FINAL RESULT</h1>
    <p className="text-slate-400 font-bold mb-12 uppercase tracking-widest">全行程終了！お疲れ様でした</p>

    <div className="w-full max-w-md bg-slate-800 rounded-3xl p-8 border-2 border-slate-700 shadow-2xl mb-8">
      <div className="text-center mb-8">
        <div className="text-xs font-black text-slate-500 uppercase mb-2">Winner</div>
        <div className={`text-6xl font-black ${winner === 'A' ? 'text-red-500' : winner === 'B' ? 'text-blue-500' : 'text-white'}`}>
          {winner === 'DRAW' ? 'DRAW' : `TEAM ${winner}`}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="text-center p-4 bg-red-500/10 rounded-2xl border border-red-500/20">
          <div className="text-[10px] font-black text-red-500 uppercase mb-1">Team A</div>
          <div className="text-3xl font-black">{aScore} <span className="text-xs">pt</span></div>
        </div>
        <div className="text-center p-4 bg-blue-500/10 rounded-2xl border border-blue-500/20">
          <div className="text-[10px] font-black text-blue-500 uppercase mb-1">Team B</div>
          <div className="text-3xl font-black">{bScore} <span className="text-xs">pt</span></div>
        </div>
      </div>
    </div>

    <div className="w-full max-w-md bg-slate-800/50 rounded-3xl p-6 border border-slate-700">
      <h3 className="flex items-center gap-2 font-black text-slate-400 mb-4 uppercase tracking-widest text-sm">
        <History size={18} /> Game History
      </h3>
      <div className="space-y-3">
        {logs.map(log => (
          <div key={log.id} className="text-xs border-b border-slate-700/50 pb-2 flex gap-3">
            <span className="text-slate-500 shrink-0 font-mono">
              {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className={
              log.type === 'CAPTURE' ? 'text-red-400 font-bold' :
              log.type === 'MISSION' ? 'text-indigo-400 font-bold' :
              log.type === 'EMERGENCY' ? 'text-amber-400 font-black' :
              'text-slate-300'
            }>
              {log.message}
            </span>
          </div>
        ))}
      </div>
    </div>

    <button
      type="button"
      onClick={onOpenSafetyDialog}
      className="mt-4 rounded-2xl bg-red-600 px-6 py-4 font-black text-white shadow-lg"
    >
      SOS / リタイア
    </button>
    {safetyDialogOpen && (
      <SafetyActionDialog
        busy={safetyActionBusy}
        onClose={onCloseSafetyDialog}
        onChoose={onChooseSafetyAction}
      />
    )}

    <button
      type="button"
      onClick={() => { void onSignOutAndReload(); }}
      className="mt-12 flex items-center gap-2 text-slate-500 font-bold hover:text-white transition-colors"
    >
      <LogOut size={18} /> 最初に戻る
    </button>
  </div>
);

export default FinalResultView;
