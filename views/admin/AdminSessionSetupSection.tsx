import type React from 'react';
import { Sparkles } from 'lucide-react';

interface AdminSessionSetupSectionProps {
  gameSessionId?: string;
  sessionInitializationBusy: boolean;
  isProcessing: boolean;
  onQuickSetupWizard: () => void;
  onInitializeGameSession: () => void;
}

const AdminSessionSetupSection: React.FC<AdminSessionSetupSectionProps> = ({
  gameSessionId,
  sessionInitializationBusy,
  isProcessing,
  onQuickSetupWizard,
  onInitializeGameSession,
}) => {
  if (!gameSessionId) {
    return (
      <section className="bg-gradient-to-r from-blue-600 to-indigo-700 p-6 rounded-3xl shadow-xl text-white">
        <div className="flex items-center gap-2 text-blue-200 text-xs font-black uppercase tracking-wider mb-2">
          <Sparkles size={16} /> First Time Setup
        </div>
        <h2 className="text-xl font-black mb-2">1クリック初期セットアップ</h2>
        <p className="text-xs text-blue-100 leading-relaxed mb-5">
          プログラミングやデータベース操作は一切不要です。<br />
          下のボタンを押すと、ゲームセッションの発行と公式ミッション（36件）の登録が一括で完了します。
        </p>
        <button
          type="button"
          onClick={onQuickSetupWizard}
          disabled={sessionInitializationBusy || isProcessing}
          className="w-full py-4 bg-white text-blue-800 rounded-2xl font-black text-sm shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2"
        >
          <Sparkles size={18} className="text-amber-500" />
          {sessionInitializationBusy ? 'セットアップ実行中...' : '🚀 1クリックでゲームを一括初期化する'}
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border-2 border-blue-100 bg-white p-4 shadow-sm flex justify-between items-center">
      <div>
        <h3 className="font-black text-xs text-slate-800">Game Session 状態</h3>
        <p className="text-xs text-slate-500 font-mono mt-0.5">{gameSessionId}</p>
      </div>
      <button
        type="button"
        onClick={onInitializeGameSession}
        disabled={sessionInitializationBusy || isProcessing}
        className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold"
      >
        状態確認
      </button>
    </section>
  );
};

export default AdminSessionSetupSection;
