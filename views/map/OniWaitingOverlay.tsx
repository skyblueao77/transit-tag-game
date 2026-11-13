import type React from 'react';
import { Lock } from 'lucide-react';
import { ONI_INITIAL_LOCK_DURATION_MS } from '../../src/game';

interface OniWaitingOverlayProps {
  remainingSeconds: number;
  formatTime: (sec: number) => string;
}

const OniWaitingOverlay: React.FC<OniWaitingOverlayProps> = ({
  remainingSeconds,
  formatTime,
}) => (
  <div className="h-full bg-slate-900 flex flex-col items-center justify-center p-6 text-center text-white">
    <div className="w-24 h-24 bg-red-600/20 rounded-full flex items-center justify-center mb-8 border-4 border-red-600/30 animate-pulse">
      <Lock size={48} className="text-red-500" />
    </div>
    <h2 className="text-3xl font-black mb-2 italic tracking-tighter uppercase">ONI WAITING...</h2>
    <p className="text-slate-400 font-bold mb-12 uppercase tracking-widest text-xs leading-relaxed">
      逃走者の移動開始から{Math.round(ONI_INITIAL_LOCK_DURATION_MS / 60000)}分間は、<br />鬼は待機しなければなりません。
    </p>
    <div className="bg-slate-800 px-10 py-6 rounded-3xl border border-slate-700 shadow-2xl">
      <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Time to Release</div>
      <div className="text-5xl font-black font-mono text-white">{formatTime(remainingSeconds)}</div>
    </div>
  </div>
);

export default OniWaitingOverlay;
