import type React from 'react';
import { Check, Copy, QrCode, Users } from 'lucide-react';
import type { User } from '../../types';

interface AdminInviteSectionProps {
  users: User[];
  inviteUrl: string;
  copiedLink: boolean;
  copiedText: boolean;
  onCopyInviteUrl: () => void;
  onCopyInviteMessage: () => void;
  onOpenQrModal: () => void;
}

const AdminInviteSection: React.FC<AdminInviteSectionProps> = ({
  users,
  inviteUrl,
  copiedLink,
  copiedText,
  onCopyInviteUrl,
  onCopyInviteMessage,
  onOpenQrModal,
}) => {
  return (
    <section className="bg-white p-5 rounded-3xl shadow-sm border border-slate-200">
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-black text-slate-800 flex items-center gap-2 text-sm uppercase">
          <Users size={18} className="text-blue-600" />
          参加者の招待（{users.length}名 登録中）
        </h3>
        <span className="text-[10px] font-black px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">
          A: {users.filter(u => u.team === 'A').length}名 / B: {users.filter(u => u.team === 'B').length}名
        </span>
      </div>

      <div className="flex items-center gap-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200 mb-3">
        <input
          type="text"
          readOnly
          value={inviteUrl}
          className="flex-1 bg-transparent text-xs font-bold text-slate-600 outline-none truncate"
        />
        <button
          type="button"
          onClick={onCopyInviteUrl}
          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-black flex items-center gap-1 active:scale-95"
        >
          {copiedLink ? <Check size={14} /> : <Copy size={14} />}
          {copiedLink ? 'コピー完了' : 'URLコピー'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCopyInviteMessage}
          className="py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
        >
          <Copy size={14} />
          {copiedText ? '案内文をコピー済' : 'LINE用案内文をコピー'}
        </button>
        <button
          type="button"
          onClick={onOpenQrModal}
          className="py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
        >
          <QrCode size={14} />
          QRコードを拡大表示
        </button>
      </div>
    </section>
  );
};

export default AdminInviteSection;
