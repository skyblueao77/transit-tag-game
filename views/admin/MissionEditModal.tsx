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
    const normalizedPoints = Math.trunc(Number(points));
    if (!Number.isInteger(normalizedPoints) || normalizedPoints < 1 || normalizedPoints > 100) {
      return;
    }
    setBusy(true);
    const mission: Mission = {
      id: initialMission?.id || `custom_${Date.now()}`,
      title: title.trim(),
      description: description.trim(),
      points: normalizedPoints,
      type,
      area: area || 'ALL',
      region: initialMission?.region || 'ALL',
      ...(typeof initialMission?.lat === 'number' ? { lat: initialMission.lat } : {}),
      ...(typeof initialMission?.lng === 'number' ? { lng: initialMission.lng } : {}),
      ...(initialMission?.isFinalMission !== undefined ? { isFinalMission: initialMission.isFinalMission } : {}),
    };
    try {
      await onSave(mission);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-slate-950/80 p-5 font-sans overflow-y-auto" role="dialog" aria-modal="true">
      <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl text-slate-800">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-base font-black text-slate-900">
            {initialMission ? 'ミッションを編集' : '新規ミッション作成'}
          </h3>
          <button type="button" onClick={onClose} disabled={busy} aria-label="モーダルを閉じる" className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600">
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
              className="w-full p-2.5 bg-slate-50 border rounded-xl text-base sm:text-xs font-bold"
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
              className="w-full p-2.5 bg-slate-50 border rounded-xl text-base sm:text-xs font-medium"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="mission-modal-points" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
                獲得ポイント (1〜100pt)
              </label>
              <input
                id="mission-modal-points"
                type="number"
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                value={points || ''}
                onChange={e => setPoints(parseInt(e.target.value, 10) || 0)}
                placeholder="15〜100"
                className="w-full p-2.5 bg-slate-50 border rounded-xl text-base sm:text-xs font-bold"
                required
              />
            </div>

            <div>
              <label htmlFor="mission-modal-type" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
                タイプ
              </label>
              <select
                id="mission-modal-type"
                value={type}
                onChange={e => setType(e.target.value as 'PHOTO' | 'CHECKIN')}
                className="w-full p-2.5 bg-slate-50 border rounded-xl text-base sm:text-xs font-bold"
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
              className="w-full p-2.5 bg-slate-50 border rounded-xl text-base sm:text-xs font-bold"
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
