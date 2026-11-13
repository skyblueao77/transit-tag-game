import type React from 'react';
import { useState } from 'react';
import { X } from 'lucide-react';
import type { Mission } from '../../types';

interface MissionEditModalProps {
  initialMission: Mission | null;
  onSave: (m: Mission) => Promise<void>;
  onClose: () => void;
}

const MissionEditModal: React.FC<MissionEditModalProps> = ({ initialMission, onSave, onClose }) => {
  const [title, setTitle] = useState(initialMission?.title || '');
  const [description, setDescription] = useState(initialMission?.description || '');
  const [points, setPoints] = useState(initialMission?.points || 20);
  const [type, setType] = useState<'PHOTO' | 'CHECKIN'>(initialMission?.type || 'PHOTO');
  const [area, setArea] = useState(initialMission?.area || 'ALL');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const mission: Mission = {
      id: initialMission?.id || `custom_${Date.now()}`,
      title: title.trim(),
      description: description.trim(),
      points: Number(points) || 20,
      type,
      area: area || 'ALL',
      region: 'ALL',
    };
    try {
      await onSave(mission);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-5 font-sans overflow-y-auto" role="dialog">
      <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl text-slate-800">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-base font-black text-slate-900">
            {initialMission ? 'ミッションを編集' : '新規ミッション作成'}
          </h3>
          <button type="button" onClick={onClose} disabled={busy} className="p-1 text-slate-400">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="mission-modal-title" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
              ミッション名（タイトル）
            </label>
            <input
              id="mission-modal-title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="例: 新宿駅の東口で写真を撮れ"
              className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold"
              required
            />
          </div>

          <div>
            <label htmlFor="mission-modal-desc" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
              詳細説明
            </label>
            <textarea
              id="mission-modal-desc"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="達成条件や撮影ルールなどを記載"
              rows={3}
              className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-medium"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="mission-modal-points" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
                獲得ポイント
              </label>
              <select
                id="mission-modal-points"
                value={points}
                onChange={e => setPoints(Number(e.target.value))}
                className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold"
              >
                <option value={15}>15 pt（手軽）</option>
                <option value={20}>20 pt（普通）</option>
                <option value={25}>25 pt（中級）</option>
                <option value={30}>30 pt（上級）</option>
                <option value={50}>50 pt（超上級）</option>
                <option value={100}>100 pt（クライマックス）</option>
              </select>
            </div>

            <div>
              <label htmlFor="mission-modal-type" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
                タイプ
              </label>
              <select
                id="mission-modal-type"
                value={type}
                onChange={e => setType(e.target.value as 'PHOTO' | 'CHECKIN')}
                className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold"
              >
                <option value="PHOTO">📸 写真撮影</option>
                <option value="CHECKIN">📍 駅チェックイン</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="mission-modal-area" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
              エリア / 路線（任意）
            </label>
            <input
              id="mission-modal-area"
              type="text"
              value={area}
              onChange={e => setArea(e.target.value)}
              placeholder="ALL / 山手線 など"
              className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="flex-1 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold text-xs"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-black text-xs shadow-md"
            >
              {busy ? '保存中...' : '保存する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default MissionEditModal;
