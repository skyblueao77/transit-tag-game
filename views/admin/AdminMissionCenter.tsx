import type React from 'react';
import { Award, Edit2, Plus, Shuffle, Trash2 } from 'lucide-react';
import type { GameConfig, Mission, MissionCompletion } from '../../types';

interface AdminMissionCenterProps {
  config: GameConfig;
  allMissionsList: Mission[];
  filteredMissions: Mission[];
  liveCompletions: Array<MissionCompletion & { id: string }>;
  missionTab: 'DISPATCH' | 'CATALOG' | 'COMPLETIONS';
  onChangeTab: (tab: 'DISPATCH' | 'CATALOG' | 'COMPLETIONS') => void;
  missionSearch: string;
  onChangeSearch: (q: string) => void;
  manualMissionId: string;
  onChangeManualMissionId: (id: string) => void;
  manualAwardTeam: 'A' | 'B';
  onChangeManualAwardTeam: (team: 'A' | 'B') => void;
  manualAwardMissionId: string;
  onChangeManualAwardMissionId: (id: string) => void;
  isProcessing: boolean;
  onCreateMission: () => void;
  onEditMission: (mission: Mission) => void;
  onDeleteMission: (mission: Mission) => void;
  onToggleMissionMode: () => void;
  onManualAssign: (team: 'A' | 'B', missionId?: string) => void;
  onShuffleMissions: () => void;
  onSyncMissionCatalog: () => void;
  onAdminAwardMission: () => void;
}

const AdminMissionCenter: React.FC<AdminMissionCenterProps> = ({
  config,
  allMissionsList,
  filteredMissions,
  liveCompletions,
  missionTab,
  onChangeTab,
  missionSearch,
  onChangeSearch,
  manualMissionId,
  onChangeManualMissionId,
  manualAwardTeam,
  onChangeManualAwardTeam,
  manualAwardMissionId,
  onChangeManualAwardMissionId,
  isProcessing,
  onCreateMission,
  onEditMission,
  onDeleteMission,
  onToggleMissionMode,
  onManualAssign,
  onShuffleMissions,
  onSyncMissionCatalog,
  onAdminAwardMission,
}) => {
  const currentMissionA = allMissionsList.find(m => m.id === config.activeMissionA);
  const currentMissionB = allMissionsList.find(m => m.id === config.activeMissionB);

  return (
    <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-black flex items-center gap-2 text-slate-900 text-sm uppercase">
          <Shuffle size={18} className="text-indigo-600" />
          ミッション管理センター
        </h3>
        <button
          type="button"
          onClick={onCreateMission}
          className="px-3 py-1.5 bg-indigo-600 text-white rounded-xl text-xs font-black flex items-center gap-1 shadow-sm active:scale-95"
        >
          <Plus size={14} /> 新規作成
        </button>
      </div>

      {/* タブ切り替え */}
      <div className="grid grid-cols-3 p-1 bg-slate-100 rounded-2xl mb-4 text-xs font-black">
        <button
          type="button"
          onClick={() => onChangeTab('DISPATCH')}
          className={`py-2 rounded-xl transition-all ${
            missionTab === 'DISPATCH' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          🎮 配信中
        </button>
        <button
          type="button"
          onClick={() => onChangeTab('CATALOG')}
          className={`py-2 rounded-xl transition-all ${
            missionTab === 'CATALOG' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          📋 一覧（{allMissionsList.length}）
        </button>
        <button
          type="button"
          onClick={() => onChangeTab('COMPLETIONS')}
          className={`py-2 rounded-xl transition-all ${
            missionTab === 'COMPLETIONS' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          🏆 達成承認（{liveCompletions.length}）
        </button>
      </div>

      {/* タブ1: 配信コントロール */}
      {missionTab === 'DISPATCH' && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={onToggleMissionMode}
            disabled={isProcessing}
            className="w-full py-2.5 rounded-xl border border-indigo-200 text-xs font-black flex items-center justify-center gap-2 bg-indigo-50 text-indigo-700 active:bg-indigo-100"
          >
            配信モード：{config.missionMode === 'SAME' ? '🔗 両チーム同一' : '🔀 チーム別'}
          </button>

          {/* A・Bチーム配信状況カード */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(['A', 'B'] as const).map(t => {
              const m = t === 'A' ? currentMissionA : currentMissionB;
              return (
                <div key={t} className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                  <div className="flex justify-between items-center mb-1">
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                      t === 'A' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'
                    }`}>
                      Team {t} 配信中
                    </span>
                    {m && <span className="text-xs font-black text-indigo-600">+{m.points}pt</span>}
                  </div>
                  <h4 className="font-black text-slate-800 text-sm mb-1">{m ? m.title : '未配信'}</h4>
                  <p className="text-[11px] text-slate-500 line-clamp-2 mb-3">
                    {m ? m.description : 'ミッションを選択して配信してください'}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onManualAssign(t)}
                      disabled={isProcessing || !manualMissionId}
                      className="flex-1 py-1.5 bg-slate-900 text-white rounded-lg text-[10px] font-bold disabled:opacity-40"
                    >
                      指定ミッションを配信
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 手動指定配信セレクター */}
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <label htmlFor="assign-mission-select" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
              手動配信用のミッションを選択
            </label>
            <select
              id="assign-mission-select"
              value={manualMissionId}
              onChange={e => onChangeManualMissionId(e.target.value)}
              className="w-full p-2 bg-white rounded-lg border border-slate-200 text-xs font-bold text-slate-800 mb-2 truncate"
            >
              <option value="">ミッションを選択してください...</option>
              {allMissionsList.map(m => (
                <option key={m.id} value={m.id}>[{m.points}pt] {m.title}</option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onManualAssign('A')}
                disabled={isProcessing || !manualMissionId}
                className="py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg text-xs font-black disabled:opacity-40"
              >
                Team A に配信
              </button>
              <button
                type="button"
                onClick={() => onManualAssign('B')}
                disabled={isProcessing || !manualMissionId}
                className="py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-xs font-black disabled:opacity-40"
              >
                Team B に配信
              </button>
            </div>
          </div>

          {/* 一括ランダム・同期 */}
          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onShuffleMissions}
              disabled={isProcessing}
              className="py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black text-xs shadow-md flex items-center justify-center gap-1.5"
            >
              <Shuffle size={14} /> 🎲 ランダム再選定
            </button>
            <button
              type="button"
              onClick={onSyncMissionCatalog}
              disabled={isProcessing}
              className="py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-xs"
            >
              🔄 公式36件を再同期
            </button>
          </div>
        </div>
      )}

      {/* タブ2: ミッション一覧・作成・編集 */}
      {missionTab === 'CATALOG' && (
        <div className="space-y-3">
          <input
            type="text"
            value={missionSearch}
            onChange={e => onChangeSearch(e.target.value)}
            placeholder="ミッション名やキーワードで検索..."
            className="w-full px-3.5 py-2.5 bg-slate-50 rounded-xl border border-slate-200 text-xs font-bold outline-none focus:border-indigo-500"
          />

          <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
            {filteredMissions.map(m => (
              <div key={m.id} className="p-3 bg-slate-50 border border-slate-200 rounded-2xl flex flex-col gap-2">
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                        {m.points}pt
                      </span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
                        {m.type === 'PHOTO' ? '📸 写真' : '📍 駅チェックイン'}
                      </span>
                    </div>
                    <h4 className="text-xs font-black text-slate-900 leading-snug">{m.title}</h4>
                    <p className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{m.description}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => onEditMission(m)}
                      className="p-1.5 text-slate-500 hover:text-slate-900 bg-white rounded-lg border border-slate-200"
                      title="編集"
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteMission(m)}
                      className="p-1.5 text-red-500 hover:text-red-700 bg-white rounded-lg border border-slate-200"
                      title="削除"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <div className="flex gap-2 pt-1 border-t border-slate-200/60">
                  <button
                    type="button"
                    onClick={() => onManualAssign('A', m.id)}
                    disabled={isProcessing}
                    className="flex-1 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 rounded-lg text-[10px] font-black border border-red-200"
                  >
                    Aに配信
                  </button>
                  <button
                    type="button"
                    onClick={() => onManualAssign('B', m.id)}
                    disabled={isProcessing}
                    className="flex-1 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-[10px] font-black border border-blue-200"
                  >
                    Bに配信
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* タブ3: 達成承認・手動スコア付与 */}
      {missionTab === 'COMPLETIONS' && (
        <div className="space-y-4">
          {/* 手動達成承認ツール */}
          <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-2xl">
            <h4 className="text-xs font-black text-indigo-900 mb-2 flex items-center gap-1.5">
              <Award size={14} /> 管理者手動達成承認（ポイント即時加算）
            </h4>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <select
                value={manualAwardTeam}
                onChange={e => onChangeManualAwardTeam(e.target.value as 'A' | 'B')}
                className="p-2 bg-white rounded-xl border border-indigo-200 text-xs font-bold text-slate-800"
              >
                <option value="A">Team A に加算</option>
                <option value="B">Team B に加算</option>
              </select>
              <select
                value={manualAwardMissionId}
                onChange={e => onChangeManualAwardMissionId(e.target.value)}
                className="p-2 bg-white rounded-xl border border-indigo-200 text-xs font-bold text-slate-800 truncate"
              >
                <option value="">ミッションを選択...</option>
                {allMissionsList.map(m => (
                  <option key={m.id} value={m.id}>[{m.points}pt] {m.title}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={onAdminAwardMission}
              disabled={isProcessing || !manualAwardMissionId}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-black disabled:opacity-50 transition-all shadow-sm"
            >
              達成を承認してポイントを加算
            </button>
          </div>

          {/* リアルタイム達成フィード */}
          <div>
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">最近の達成履歴</h4>
            <div className="max-h-60 overflow-y-auto space-y-2">
              {liveCompletions.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-4">まだ達成報告はありません</p>
              ) : (
                liveCompletions.slice(0, 20).map(c => {
                  const mission = allMissionsList.find(m => m.id === c.missionId);
                  return (
                    <div key={c.id} className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs flex justify-between items-center">
                      <div>
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${
                            c.team === 'A' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'
                          }`}>
                            Team {c.team}
                          </span>
                          <span className="font-black text-slate-800">{mission?.title || c.missionId}</span>
                        </div>
                        <span className="text-[10px] text-slate-400">報告者: {c.completedBy}</span>
                      </div>
                      <span className="font-black text-emerald-600 shrink-0">+{c.points}pt</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default AdminMissionCenter;
