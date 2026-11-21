import type React from 'react';
import { Check, Copy, Lock, LockOpen, QrCode, RefreshCw, Users } from 'lucide-react';
import type { User } from '../../types';

interface AdminInviteSectionProps {
  users: User[];
  inviteUrl: string;
  copiedLink: boolean;
  copiedText: boolean;
  currentJoinCode?: string;
  registrationOpen?: boolean;
  isRotatingJoinCode?: boolean;
  isTogglingRegistration?: boolean;
  onCopyInviteUrl: () => void;
  onCopyInviteMessage: () => void;
  onOpenQrModal: () => void;
  onRotateJoinCode?: () => void;
  onToggleRegistrationOpen?: () => void;
}

const AdminInviteSection: React.FC<AdminInviteSectionProps> = ({
  users,
  inviteUrl,
  copiedLink,
  copiedText,
  currentJoinCode,
  registrationOpen,
  isRotatingJoinCode = false,
  isTogglingRegistration = false,
  onCopyInviteUrl,
  onCopyInviteMessage,
  onOpenQrModal,
  onRotateJoinCode,
  onToggleRegistrationOpen,
}) => {
  const isRegOpen = registrationOpen !== false;

  return (
    <section className="bg-white p-5 rounded-3xl shadow-sm border border-slate-200">
      <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
        <h3 className="font-black text-slate-800 flex items-center gap-2 text-sm uppercase">
          <Users size={18} className="text-blue-600" />
          参加者の招待（{users.length}名 登録中）
        </h3>
        <span className="text-[10px] font-black px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">
          A: {users.filter(u => u.team === 'A').length}名 / B: {users.filter(u => u.team === 'B').length}名
        </span>
      </div>

      {currentJoinCode && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-blue-50/70 border border-blue-200 rounded-xl px-3 py-2 mb-3">
          <div className="min-w-0">
            <span className="text-[10px] font-black text-blue-700 uppercase tracking-wider block">現在の招待コード</span>
            <code className="text-xs font-mono font-bold text-slate-800 break-all">{currentJoinCode}</code>
          </div>
          <span className={`text-[10px] font-black px-2 py-1 rounded-full shrink-0 ${
            isRegOpen ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
          }`}>
            {isRegOpen ? '参加受付中' : '参加受付停止中'}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200 mb-3">
        <input
          type="text"
          readOnly
          aria-label="招待URL"
          value={inviteUrl}
          className="flex-1 min-w-0 bg-transparent text-base sm:text-xs font-bold text-slate-600 outline-none truncate"
        />
        <button
          type="button"
          onClick={onCopyInviteUrl}
          className="shrink-0 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-black flex items-center gap-1 active:scale-95"
        >
          {copiedLink ? <Check size={14} /> : <Copy size={14} />}
          {copiedLink ? 'コピー完了' : 'URLコピー'}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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

      {(onRotateJoinCode || onToggleRegistrationOpen) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2 pt-2 border-t border-slate-100">
          {onRotateJoinCode && (
            <button
              type="button"
              onClick={onRotateJoinCode}
              disabled={isRotatingJoinCode}
              className="py-2 px-3 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={13} className={isRotatingJoinCode ? 'animate-spin' : ''} />
              招待コード再発行（旧QR無効化）
            </button>
          )}
          {onToggleRegistrationOpen && (
            <button
              type="button"
              onClick={onToggleRegistrationOpen}
              disabled={isTogglingRegistration}
              className={`py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 border transition-colors disabled:opacity-50 ${
                isRegOpen
                  ? 'bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-200'
                  : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200'
              }`}
            >
              {isRegOpen ? <Lock size={13} /> : <LockOpen size={13} />}
              {isRegOpen ? '新規参加受付を停止する' : '新規参加受付を再開する'}
            </button>
          )}
        </div>
      )}
    </section>
  );
};

export default AdminInviteSection;
