import type React from 'react';
import { useEffect, useState } from 'react';
import { Sliders } from 'lucide-react';
import { toast } from 'sonner';
import type { GameConfig } from '../../types';
import type { VictoryMode } from '../../src/game/types';
import { DEFAULT_DYNAMIC_RULE_SETTINGS } from '../../constants';
import { updateAdminRuleSettings } from '../../src/infrastructure/firebase/clientFirestoreGateways';

interface AdminRuleSettingsSectionProps {
  config: GameConfig;
  requireSessionId: () => string | null;
}

const AdminRuleSettingsSection: React.FC<AdminRuleSettingsSectionProps> = ({
  config,
  requireSessionId,
}) => {
  const [ruleVictoryMode, setRuleVictoryMode] = useState<VictoryMode>(
    config.victoryMode ?? DEFAULT_DYNAMIC_RULE_SETTINGS.victoryMode,
  );
  const [ruleShinkansenMaxMinutes, setRuleShinkansenMaxMinutes] = useState<number>(
    config.shinkansenMaxMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxMinutes,
  );
  const [ruleShinkansenMaxSegments, setRuleShinkansenMaxSegments] = useState<number>(
    config.shinkansenMaxSegments ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxSegments,
  );
  const [rulePostShinkansenWaitMinutes, setRulePostShinkansenWaitMinutes] = useState<number>(
    config.postShinkansenWaitMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.postShinkansenWaitMinutes,
  );
  const [rulePeriodicRevealIntervalMinutes, setRulePeriodicRevealIntervalMinutes] = useState<number>(
    config.periodicRevealIntervalMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealIntervalMinutes,
  );
  const [rulePeriodicRevealDurationMinutes, setRulePeriodicRevealDurationMinutes] = useState<number>(
    config.periodicRevealDurationMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealDurationMinutes,
  );
  const [ruleCaptureWaitMinutes, setRuleCaptureWaitMinutes] = useState<number>(
    config.captureWaitMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.captureWaitMinutes,
  );
  const [ruleMissionPenaltyRevealMinutes, setRuleMissionPenaltyRevealMinutes] = useState<number>(
    config.missionPenaltyRevealMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.missionPenaltyRevealMinutes,
  );
  const [isSavingRules, setIsSavingRules] = useState(false);

  useEffect(() => {
    if (config.victoryMode) setRuleVictoryMode(config.victoryMode);
    if (config.shinkansenMaxMinutes !== undefined) setRuleShinkansenMaxMinutes(config.shinkansenMaxMinutes);
    if (config.shinkansenMaxSegments !== undefined) setRuleShinkansenMaxSegments(config.shinkansenMaxSegments);
    if (config.postShinkansenWaitMinutes !== undefined) setRulePostShinkansenWaitMinutes(config.postShinkansenWaitMinutes);
    if (config.periodicRevealIntervalMinutes !== undefined) setRulePeriodicRevealIntervalMinutes(config.periodicRevealIntervalMinutes);
    if (config.periodicRevealDurationMinutes !== undefined) setRulePeriodicRevealDurationMinutes(config.periodicRevealDurationMinutes);
    if (config.captureWaitMinutes !== undefined) setRuleCaptureWaitMinutes(config.captureWaitMinutes);
    if (config.missionPenaltyRevealMinutes !== undefined) setRuleMissionPenaltyRevealMinutes(config.missionPenaltyRevealMinutes);
  }, [
    config.victoryMode,
    config.shinkansenMaxMinutes,
    config.shinkansenMaxSegments,
    config.postShinkansenWaitMinutes,
    config.periodicRevealIntervalMinutes,
    config.periodicRevealDurationMinutes,
    config.captureWaitMinutes,
    config.missionPenaltyRevealMinutes,
  ]);

  const handleSaveRuleSettings = async (): Promise<void> => {
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId || isSavingRules) return;

    setIsSavingRules(true);
    try {
      const result = await updateAdminRuleSettings(
        {
          victoryMode: ruleVictoryMode,
          shinkansenMaxMinutes: ruleShinkansenMaxMinutes,
          shinkansenMaxSegments: ruleShinkansenMaxSegments,
          postShinkansenWaitMinutes: rulePostShinkansenWaitMinutes,
          periodicRevealIntervalMinutes: rulePeriodicRevealIntervalMinutes,
          periodicRevealDurationMinutes: rulePeriodicRevealDurationMinutes,
          captureWaitMinutes: ruleCaptureWaitMinutes,
          missionPenaltyRevealMinutes: ruleMissionPenaltyRevealMinutes,
        },
        expectedSessionId,
      );

      if (result.ok) {
        toast.success('ルール設定を更新しました！参加者にリアルタイム反映されます。');
      } else {
        toast.error(`ルール設定の更新に失敗しました: ${result.reason}`);
      }
    } catch (error) {
      console.error('Error saving rule settings:', error);
      toast.error('ルール設定の更新中にエラーが発生しました');
    } finally {
      setIsSavingRules(false);
    }
  };

  return (
    <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <div>
          <h3 className="font-black flex items-center gap-2 text-slate-800 uppercase tracking-tight text-sm">
            <Sliders size={18} className="text-indigo-600" />
            広域交通鬼ごっこ ルール規定設定（リアルタイム可変）
          </h3>
          <p className="text-xs text-slate-500 font-medium mt-1">
            各「◯」の数値はゲーム進行中も即座に変更・全体配信可能です。
          </p>
        </div>
        <span className={`text-xs font-black px-3 py-1 rounded-full self-start sm:self-auto ${
          ruleVictoryMode === 'SURVIVAL' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-purple-50 text-purple-700 border border-purple-200'
        }`}>
          {ruleVictoryMode === 'SURVIVAL' ? '🏃‍♂️ サバイバル制' : '🏆 ポイント交代制'}
        </span>
      </div>

      <div className="space-y-4">
        {/* 勝敗条件セレクター */}
        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
          <div className="text-xs font-black text-slate-700 block mb-2">
            1. 勝敗条件（ゲームモード）
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setRuleVictoryMode('SURVIVAL')}
              className={`p-3 rounded-xl text-left border transition-all ${
                ruleVictoryMode === 'SURVIVAL'
                  ? 'bg-emerald-500 text-white border-emerald-600 shadow-md font-black'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 font-bold'
              }`}
            >
              <div className="text-xs">🏃‍♂️ サバイバル制</div>
              <div className={`text-[10px] mt-0.5 ${ruleVictoryMode === 'SURVIVAL' ? 'text-emerald-100' : 'text-slate-500'}`}>
                逃走者: タイムアップ生存で勝利<br />鬼: 全逃走者確保で即勝利
              </div>
            </button>
            <button
              type="button"
              onClick={() => setRuleVictoryMode('SCORE_SWAP')}
              className={`p-3 rounded-xl text-left border transition-all ${
                ruleVictoryMode === 'SCORE_SWAP'
                  ? 'bg-purple-600 text-white border-purple-700 shadow-md font-black'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 font-bold'
              }`}
            >
              <div className="text-xs">🏆 ポイント交代制</div>
              <div className={`text-[10px] mt-0.5 ${ruleVictoryMode === 'SCORE_SWAP' ? 'text-purple-100' : 'text-slate-500'}`}>
                攻守交代しながら獲得スコアと確保ボーナスで勝敗を競う
              </div>
            </button>
          </div>
        </div>

        {/* 新幹線・特急等利用制限 */}
        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
          <h4 className="text-xs font-black text-slate-700">
            🚄 2. 新幹線・特急利用制限（バランス調整）
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">
                <span>最長連続乗車（分） <span className="text-[10px] text-slate-400 ml-1">0=無制限</span></span>
                <input
                  type="number"
                  min={0}
                  max={600}
                  step={10}
                  value={ruleShinkansenMaxMinutes}
                  onChange={e => setRuleShinkansenMaxMinutes(Math.min(600, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                  className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                />
              </label>
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">
                <span>最長連続区間（区間） <span className="text-[10px] text-slate-400 ml-1">0=無制限</span></span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={ruleShinkansenMaxSegments}
                  onChange={e => setRuleShinkansenMaxSegments(Math.min(50, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                  className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                />
              </label>
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">
                <span>下車後待機義務（分）</span>
                <input
                  type="number"
                  min={1}
                  max={180}
                  step={5}
                  value={rulePostShinkansenWaitMinutes}
                  onChange={e => setRulePostShinkansenWaitMinutes(Math.min(180, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                  className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                />
              </label>
            </div>
          </div>
        </div>

        {/* 位置情報開示＆ペナルティ設定 */}
        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
          <h4 className="text-xs font-black text-slate-700">
            📍 3. 位置開示・確保・ペナルティ設定
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">
                <span>定期開示 間隔（分ごと）</span>
                <input
                  type="number"
                  min={5}
                  max={120}
                  step={5}
                  value={rulePeriodicRevealIntervalMinutes}
                  onChange={e => setRulePeriodicRevealIntervalMinutes(Math.min(120, Math.max(5, parseInt(e.target.value, 10) || 5)))}
                  className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                />
              </label>
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">
                <span>定期開示 継続時間（分間）</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={rulePeriodicRevealDurationMinutes}
                  onChange={e => setRulePeriodicRevealDurationMinutes(Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                  className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                />
              </label>
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">
                <span>確保後 待機時間（分間）</span>
                <input
                  type="number"
                  min={5}
                  max={120}
                  step={5}
                  value={ruleCaptureWaitMinutes}
                  onChange={e => setRuleCaptureWaitMinutes(Math.min(120, Math.max(5, parseInt(e.target.value, 10) || 5)))}
                  className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                />
              </label>
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">
                <span>ペナルティ常時開示（分間）</span>
                <input
                  type="number"
                  min={1}
                  max={180}
                  step={5}
                  value={ruleMissionPenaltyRevealMinutes}
                  onChange={e => setRuleMissionPenaltyRevealMinutes(Math.min(180, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                  className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                />
              </label>
            </div>
          </div>
        </div>

        {/* 保存ボタン */}
        <button
          type="button"
          onClick={handleSaveRuleSettings}
          disabled={isSavingRules}
          className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl font-black text-sm shadow-md flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"
        >
          <Sliders size={16} />
          {isSavingRules ? 'ルール設定を保存中...' : '⚙️ ルール規定設定を保存・全参加者へ即時反映'}
        </button>
      </div>
    </section>
  );
};

export default AdminRuleSettingsSection;
