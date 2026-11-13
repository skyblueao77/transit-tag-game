import type React from 'react';
import { Megaphone, Send } from 'lucide-react';

interface AdminBroadcastSectionProps {
  broadcastInput: string;
  isSendingBroadcast: boolean;
  onChangeBroadcastInput: (value: string) => void;
  onSubmitBroadcast: (e: React.FormEvent) => void;
}

const AdminBroadcastSection: React.FC<AdminBroadcastSectionProps> = ({
  broadcastInput,
  isSendingBroadcast,
  onChangeBroadcastInput,
  onSubmitBroadcast,
}) => {
  return (
    <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
      <h3 className="font-black flex items-center gap-2 mb-2 text-slate-800 uppercase tracking-tight text-sm">
        <Megaphone size={18} className="text-amber-500" />
        参加者全員へ一斉通知（ブロードキャスト）
      </h3>
      <p className="text-xs text-slate-500 font-medium mb-3">
        全プレイヤーの画面にトースト通知を一斉表示し、タイムラインログに記録します。
      </p>
      <form onSubmit={onSubmitBroadcast} className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={broadcastInput}
          onChange={e => onChangeBroadcastInput(e.target.value)}
          maxLength={200}
          placeholder="例: 14:00から中間ボーナスミッション開始！"
          className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-800 outline-none focus:border-blue-500"
          disabled={isSendingBroadcast}
        />
        <button
          type="submit"
          disabled={isSendingBroadcast || !broadcastInput.trim()}
          className="py-3 px-5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-xl font-black text-xs shadow-md flex items-center justify-center gap-1.5 shrink-0 transition-all active:scale-95"
        >
          <Send size={14} /> 一斉送信
        </button>
      </form>
    </section>
  );
};

export default AdminBroadcastSection;
