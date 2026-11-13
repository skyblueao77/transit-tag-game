import type React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { PrepareGameResetPreview } from '../../src/application/gameplayPorts';

interface AdminMasterResetSectionProps {
  isProcessing: boolean;
  resetPreview: PrepareGameResetPreview | null;
  resetConfirmationText: string;
  onChangeResetConfirmationText: (val: string) => void;
  resetError: string | null;
  resetSuccess: string | null;
  onPrepareGameReset: () => Promise<void>;
  onExecuteGameReset: () => Promise<void>;
}

const AdminMasterResetSection: React.FC<AdminMasterResetSectionProps> = ({
  isProcessing,
  resetPreview,
  resetConfirmationText,
  onChangeResetConfirmationText,
  resetError,
  resetSuccess,
  onPrepareGameReset,
  onExecuteGameReset,
}) => (
  <section className="rounded-2xl border-2 border-red-100 bg-red-50 p-4 text-slate-800">
    <h3 className="flex items-center gap-2 font-black text-red-700 text-xs">
      <AlertTriangle size={16} /> マスターリセット（新セッション開始）
    </h3>
    <p className="mt-1 text-[11px] font-medium text-slate-600">
      現在のセッションを終了し、すべてをリセットして最初から再スタートします。
    </p>
    <button
      type="button"
      onClick={() => void onPrepareGameReset()}
      disabled={isProcessing}
      className="mt-3 w-full rounded-xl bg-red-600 py-2.5 font-black text-white text-xs disabled:opacity-50"
    >
      {isProcessing ? '取得中...' : 'リセット確認画面を開く'}
    </button>

    {resetPreview && (
      <div className="mt-3 space-y-2 rounded-xl bg-white p-3 text-xs">
        <p>対象Player: <strong>{resetPreview.participantCount}名</strong></p>
        <label className="block pt-1 font-bold">確認のため「RESET」と入力してください:
          <input value={resetConfirmationText} onChange={e => onChangeResetConfirmationText(e.target.value)} className="mt-1 w-full rounded-lg border p-2 text-xs" />
        </label>
        <button
          type="button"
          onClick={() => void onExecuteGameReset()}
          disabled={resetConfirmationText !== 'RESET'}
          className="mt-2 w-full rounded-xl bg-red-600 py-2.5 font-black text-white disabled:bg-slate-300"
        >
          リセットを実行して新規ゲームを開始
        </button>
      </div>
    )}
    {resetError && <p role="alert" className="mt-2 text-xs font-bold text-red-700">{resetError}</p>}
    {resetSuccess && <p role="status" className="mt-2 text-xs font-bold text-emerald-700">{resetSuccess}</p>}
  </section>
);

export default AdminMasterResetSection;
