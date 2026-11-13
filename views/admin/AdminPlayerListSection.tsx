import type React from 'react';
import { ArrowLeftRight, RefreshCw, Trash2, Users } from 'lucide-react';
import type { GameConfig, User } from '../../types';
import { getPlayerRole } from '../../src/game';

interface AdminPlayerListSectionProps {
  config: GameConfig;
  users: User[];
  nowMs: number;
  modifyingPlayerIds: Set<string>;
  resumingPlayerIds: Set<string>;
  onChangePlayerTeam: (user: User) => Promise<void>;
  onResumePlayer: (user: User) => Promise<void>;
  onDeletePlayer: (user: User) => Promise<void>;
}

const AdminPlayerListSection: React.FC<AdminPlayerListSectionProps> = ({
  config,
  users,
  nowMs,
  modifyingPlayerIds,
  resumingPlayerIds,
  onChangePlayerTeam,
  onResumePlayer,
  onDeletePlayer,
}) => (
  <section className="bg-white p-5 rounded-3xl shadow-sm border border-slate-200">
    <h3 className="font-black flex items-center gap-2 mb-3 text-slate-800 uppercase tracking-tight text-sm">
      <Users size={18} className="text-blue-600" />
      参加プレイヤー ({users.length}名)
    </h3>
    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
      {users.map(u => {
        const effectiveRole = getPlayerRole(u, config);
        return (
        <div key={u.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 flex justify-between items-center">
          <div>
            <div className="text-xs font-black text-slate-800">{u.name}</div>
            <div className="flex flex-wrap gap-1 mt-1">
              <span className={`text-[9px] font-black px-1.5 py-0.2 rounded-full ${
                u.team === 'A' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'
              }`}>TEAM {u.team}</span>
              <span className="text-[9px] font-black px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-600">{effectiveRole}</span>
              <span className={`text-[9px] font-black px-1.5 py-0.2 rounded-full ${
                u.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'
              }`}>{u.status}</span>
              {Boolean(u.penaltyRevealUntil && u.penaltyRevealUntil > nowMs) && (
                <span className="text-[9px] font-black px-1.5 py-0.2 rounded-full bg-rose-500 text-white animate-pulse">
                  🚨 ペナルティ開示中
                </span>
              )}
              {Boolean(u.protectionZone && u.protectionZone !== 'NONE') && (
                <span className="text-[9px] font-black px-1.5 py-0.2 rounded-full bg-indigo-100 text-indigo-700">
                  🛡️ {u.protectionZone === 'GREEN_CAR' ? 'グリーン車' : '特例保護'}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void onChangePlayerTeam(u)}
              disabled={modifyingPlayerIds.has(u.id)}
              title={`TEAM ${u.team === 'A' ? 'B' : 'A'} へ変更`}
              className="px-2 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-[10px] font-black rounded-lg border border-slate-300 flex items-center gap-1 active:scale-95"
            >
              <ArrowLeftRight size={12} /> {u.team === 'A' ? '→B' : '→A'}
            </button>
            <button
              type="button"
              onClick={() => void onResumePlayer(u)}
              disabled={resumingPlayerIds.has(u.id) || modifyingPlayerIds.has(u.id)}
              title="待機状態から復帰させる"
              className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg border border-emerald-100 hover:bg-emerald-100 active:scale-95"
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              onClick={() => void onDeletePlayer(u)}
              disabled={modifyingPlayerIds.has(u.id)}
              title="プレイヤーを削除"
              className="p-1.5 bg-red-50 text-red-600 rounded-lg border border-red-100 hover:bg-red-100 active:scale-95"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        );
      })}
    </div>
  </section>
);

export default AdminPlayerListSection;
