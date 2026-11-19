import type React from 'react';
import { XCircle } from 'lucide-react';
import type { SafetyAction, SafetyReasonCode } from '../../game/playerSafety';

interface SafetyActionDialogProps {
  busy: boolean;
  onClose: () => void;
  onChoose: (action: SafetyAction, reasonCode: SafetyReasonCode) => Promise<void>;
}

const SafetyActionDialog: React.FC<SafetyActionDialogProps> = ({ busy, onClose, onChoose }) => (
  <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-slate-950/80 p-5 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Safety Action">
    <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-black text-slate-900">緊急連絡 / リタイア</h2>
        <button type="button" onClick={onClose} disabled={busy} aria-label="閉じる" className="rounded-lg p-2 text-slate-500 disabled:opacity-50">
          <XCircle size={22} />
        </button>
      </div>
      <div className="mb-4 rounded-2xl border border-red-300 bg-red-50 p-3 text-xs font-bold leading-relaxed text-red-900">
        🚨 急病・怪我・事故など生命や安全に関わる緊急時は、本アプリでの連絡よりも先に
        <span className="font-black underline">119番（救急・消防）・110番（警察）・最寄りの駅係員</span>
        へ直接連絡することを最優先してください。本アプリは救助・緊急通報サービスではありません。
      </div>
      <p className="mb-4 text-sm font-medium text-slate-600">
        該当する内容を選択してください。詳細な個人情報は記録されません。Emergencyを選ぶと、最新の位置情報がある場合に限り、正確な位置を管理者だけに共有し、更新が途絶えても管理者が解除するまで最終位置を保持します。リタイアでは位置を共有しません。
      </p>
      <div className="grid gap-2">
        <button type="button" disabled={busy} onClick={() => void onChoose('EMERGENCY', 'ILLNESS_OR_INJURY')} className="rounded-xl bg-red-50 px-4 py-3 text-left font-bold text-red-800 disabled:opacity-50">
          急病・怪我
        </button>
        <button type="button" disabled={busy} onClick={() => void onChoose('EMERGENCY', 'EQUIPMENT_ISSUE')} className="rounded-xl bg-red-50 px-4 py-3 text-left font-bold text-red-800 disabled:opacity-50">
          機材トラブル
        </button>
        <button type="button" disabled={busy} onClick={() => void onChoose('EMERGENCY', 'OTHER')} className="rounded-xl bg-red-50 px-4 py-3 text-left font-bold text-red-800 disabled:opacity-50">
          その他の緊急事態
        </button>
        <button type="button" disabled={busy} onClick={() => void onChoose('RETIRE', 'RETIREMENT_REQUEST')} className="mt-2 rounded-xl bg-slate-900 px-4 py-3 text-left font-bold text-white disabled:opacity-50">
          リタイア
        </button>
      </div>
      {busy && <p className="mt-4 text-center text-sm font-bold text-slate-500">送信中...</p>}
      <p className="mt-4 text-xs text-slate-500">送信できない場合はLINE等で運営へ直接連絡してください。</p>
    </div>
  </div>
);

export default SafetyActionDialog;
