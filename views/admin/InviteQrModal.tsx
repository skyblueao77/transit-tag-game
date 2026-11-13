import type React from 'react';
import { X } from 'lucide-react';

interface InviteQrModalProps {
  qrDataUri: string;
  copiedLink: boolean;
  onCopyInviteUrl: () => void;
  onClose: () => void;
}

const InviteQrModal: React.FC<InviteQrModalProps> = ({
  qrDataUri,
  copiedLink,
  onCopyInviteUrl,
  onClose,
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-5 overflow-y-auto" role="dialog">
    <div className="w-full max-w-sm max-h-[90dvh] overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl text-center">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-base font-black text-slate-900">参加用 QRコード</h3>
        <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600">
          <X size={20} />
        </button>
      </div>

      <div className="flex justify-center p-4 bg-white rounded-2xl border border-slate-100 shadow-inner mb-4">
        {qrDataUri && (
          <img src={qrDataUri} alt="参加用QRコード" className="w-44 h-44" />
        )}
      </div>

      <p className="text-xs font-bold text-slate-600 mb-4">
        参加者のスマートフォンでこのQRコードを読み取ってください。<br />
        （アプリインストール・メール登録不要）
      </p>

      <button
        type="button"
        onClick={onCopyInviteUrl}
        className="w-full py-3 bg-blue-600 text-white rounded-xl font-black text-xs shadow-md"
      >
        {copiedLink ? 'URLコピー完了！' : '参加URLをコピー'}
      </button>
    </div>
  </div>
);

export default InviteQrModal;
