import React, { useState, useEffect, useMemo } from 'react';
import { GameConfig, Mission, User } from '../types';
import { FINAL_MISSIONS } from '../constants';
import { Target, CheckCircle2, MapPin, Hourglass, Camera, Hash } from 'lucide-react';

interface Props {
  config: GameConfig;
  user: User;
  onComplete: (points: number) => Promise<void>;
  onExposeLocation: () => Promise<void>;
  missions: Mission[];
}

const MissionView: React.FC<Props> = ({ config, user, onComplete, onExposeLocation, missions = [] }) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFinalReported, setIsFinalReported] = useState(false);
  const [lastCompletedMissionId, setLastCompletedMissionId] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState('');

  // チームごとのアクティブミッションID
  const activeMissionId: string = (
    user.team === 'A' ? config.activeMissionA : config.activeMissionB
  ) ?? '';

  // 現在の通常ミッションオブジェクト
  const currentMission = useMemo((): Mission | null => {
    if (!activeMissionId || !Array.isArray(missions) || missions.length === 0) return null;
    return missions.find(m => m != null && m.id === activeMissionId) ?? null;
  }, [activeMissionId, missions]);

  // 最終ミッションオブジェクト（activeFinalMissionId で特定、なければ先頭）
  const finalMission = useMemo((): Mission => {
    const id = config.activeFinalMissionId;
    if (id) {
      const found = FINAL_MISSIONS.find(m => m.id === id);
      if (found) return found;
    }
    return FINAL_MISSIONS[0];
  }, [config.activeFinalMissionId]);

  // 新しいミッションが来たら完了表示をリセット
  useEffect(() => {
    if (activeMissionId !== lastCompletedMissionId) {
      setLastCompletedMissionId(null);
    }
  }, [activeMissionId]);

  // 最終ミッションのカウントダウン
  useEffect(() => {
    if (!config.isFinalMissionActive) return;
    const timer = setInterval(() => {
      const now = Date.now();
      const diff = (config.finalMissionEndTime ?? 0) - now;
      if (diff <= 0) {
        setTimeLeft('00:00:00');
        clearInterval(timer);
      } else {
        const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
        const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
        const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
        setTimeLeft(`${h}:${m}:${s}`);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [config.isFinalMissionActive, config.finalMissionEndTime]);

  // ミッション完了報告（座標判定なし・自主報告）
  const handleComplete = async () => {
    const mission: Mission = config.isFinalMissionActive ? finalMission : (currentMission as Mission);
    if (!mission) return;
    if (config.isFinalMissionActive && isFinalReported) return;
    if (!config.isFinalMissionActive && activeMissionId === lastCompletedMissionId) return;

    if (!confirm(`ミッション「${mission.title}」を完了報告しますか？\n\n※写真はLINEで運営に送ってください。`)) return;

    setIsSubmitting(true);
    try {
      await onComplete(mission.points);

      if (config.isFinalMissionActive) {
        setIsFinalReported(true);
        alert('最終ミッション達成！おめでとうございます！\n写真をLINEで送るのを忘れずに！');
      } else {
        setLastCompletedMissionId(mission.id);
        alert(`ミッション完了！ +${mission.points}pt 加算されました。\n写真をLINEで送るのを忘れずに！`);
      }
    } catch (error) {
      console.error('Mission error:', error);
      alert('エラーが発生しました。');
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- 最終ミッション画面 ---
  if (config.isFinalMissionActive) {
    return (
      <div className="p-6 min-h-full flex flex-col items-center justify-center bg-slate-900 text-white">
        <div className="w-full max-w-sm">
          <div className="bg-red-600 text-white text-[10px] font-black uppercase tracking-widest py-1 px-4 rounded-full w-fit mx-auto mb-6 animate-pulse">
            Final Mission Active
          </div>
          <h2 className="text-3xl font-black text-center mb-2 italic">FINAL CLIMAX</h2>
          <p className="text-red-400 text-center text-sm font-bold mb-8">決戦の時が来た</p>

          <div className="bg-slate-800 rounded-3xl p-6 border-2 border-red-600/50 shadow-2xl mb-6">
            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 text-center">Time Remaining</div>
            <div className="text-5xl font-black font-mono mb-6 text-white text-center">{timeLeft}</div>

            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Target className="text-red-500 shrink-0 mt-1" size={20} />
                <div>
                  <div className="text-xs font-black text-slate-400 uppercase mb-1">Final Mission</div>
                  <div className="text-base font-bold leading-tight text-white">{finalMission.title}</div>
                </div>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed pl-8">{finalMission.description}</p>
              <div className="pl-8 flex items-center gap-2 mt-2">
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                  finalMission.type === 'PHOTO' ? 'bg-amber-900/50 text-amber-400' : 'bg-emerald-900/50 text-emerald-400'
                }`}>
                  {finalMission.type === 'PHOTO' ? '📸 写真をLINEで送る' : '📍 チェックインして報告'}
                </span>
                <span className="text-[10px] font-black text-red-400">+{finalMission.points} PT</span>
              </div>
            </div>
          </div>

          <button
            onClick={handleComplete}
            disabled={isSubmitting || isFinalReported}
            className={`w-full py-5 font-black rounded-2xl shadow-xl transition-all text-xl uppercase ${
              isFinalReported
                ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                : 'bg-red-600 hover:bg-red-700 text-white active:scale-95'
            }`}
          >
            {isSubmitting ? 'Processing...' : isFinalReported ? '報告済み / Reported' : '完了報告を行う'}
          </button>
        </div>
      </div>
    );
  }

  // --- 通常ミッション完了後の待機画面 ---
  if (lastCompletedMissionId !== null && activeMissionId === lastCompletedMissionId) {
    return (
      <div className="p-4 flex flex-col items-center justify-center min-h-[60vh] text-center">
        <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mb-6 text-emerald-500">
          <CheckCircle2 size={40} />
        </div>
        <h2 className="text-2xl font-black text-slate-900 mb-2 italic">MISSION ACHIEVED!</h2>
        <p className="text-slate-500 font-bold mb-6 uppercase tracking-widest text-xs">
          ミッション達成！次の配信を待機中...
        </p>
        <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 w-full max-w-xs mb-4">
          <p className="text-sm text-emerald-700 font-bold">
            📸 写真のLINE送付を忘れずに！
          </p>
        </div>
        <div className="bg-white p-6 rounded-3xl border-2 border-slate-100 shadow-sm w-full max-w-xs">
          <p className="text-sm text-slate-600 font-medium">
            次の指令が出るまで<br />引き続き移動してください。
          </p>
        </div>
      </div>
    );
  }

  // --- 通常ミッション表示 ---
  return (
    <div className="p-4 space-y-4">
      <div className="bg-white rounded-3xl p-6 border shadow-sm">
        <div className="flex items-center justify-between mb-6">
          <h3 className="flex items-center gap-2 font-black text-slate-800 uppercase tracking-wider">
            <Target size={20} className="text-blue-600" />
            Current Mission
          </h3>
          <div className="bg-blue-50 text-blue-600 text-[10px] font-black px-3 py-1 rounded-full uppercase">
            Team {user.team}
          </div>
        </div>

        {currentMission ? (
          <div className="space-y-5">
            <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100">
              {/* ミッションタイプバッジ */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`text-[10px] font-black px-2 py-0.5 rounded-full flex items-center gap-1 ${
                  currentMission.type === 'PHOTO'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-emerald-100 text-emerald-700'
                }`}>
                  {currentMission.type === 'PHOTO' ? <Camera size={10} /> : <MapPin size={10} />}
                  {currentMission.type === 'PHOTO' ? '写真をLINEで送る' : 'チェックイン'}
                </span>
                <span className="text-[10px] font-black text-slate-400 flex items-center gap-0.5">
                  <Hash size={10} />{currentMission.points} PT
                </span>
              </div>

              <h4 className="text-xl font-bold text-slate-800 mb-2 leading-snug">
                {currentMission.title}
              </h4>
              <p className="text-sm text-slate-500 leading-relaxed">
                {currentMission.description}
              </p>
            </div>

            {/* 写真送付リマインダー */}
            <div className="bg-amber-50 rounded-2xl p-3 border border-amber-100 flex items-center gap-2">
              <Camera size={16} className="text-amber-600 shrink-0" />
              <p className="text-xs text-amber-800 font-bold">
                達成後は必ず写真をLINEグループに送ってください
              </p>
            </div>

            <button
              onClick={handleComplete}
              disabled={isSubmitting}
              className="w-full py-5 bg-blue-600 text-white font-black rounded-2xl shadow-xl flex items-center justify-center gap-2 active:scale-95 transition-all text-lg disabled:bg-slate-300"
            >
              <CheckCircle2 size={24} /> 完了報告を行う
            </button>
          </div>
        ) : (
          <div className="text-center py-12">
            <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300">
              <Hourglass size={40} className="animate-pulse" />
            </div>
            <p className="text-slate-400 text-sm font-bold">
              本部からのミッション配信を<br />お待ちください。
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default MissionView;