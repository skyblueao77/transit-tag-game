import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GameConfig, User, GameLog, Mission } from '../types';
import { MISSIONS } from '../constants';
import {
  Users, Lock, Trash2, Shield, Trophy, Play,
  AlertTriangle, Shuffle, XCircle, Flag, MapPin,
  RefreshCw 
} from 'lucide-react';
import { signInAdmin } from '../src/infrastructure/firebase/auth';
import { resumePlayer, swapTeamRoles } from '../src/application/adminGameStateActions';
import { revealPlayerLocations } from '../src/application/adminReveal';
import type { AdminRevealScope } from '../src/game/adminReveal';
import { firebaseAdminGameStateGateway } from '../src/infrastructure/firebase/adminActions';
import { firebaseAdminRevealGateway } from '../src/infrastructure/firebase/adminRevealActions';
import { transitionGamePhase } from '../src/application/adminPhaseActions';
import { firebaseAdminPhaseGateway } from '../src/infrastructure/firebase/adminPhaseActions';
import { setMissionMode, assignMissions, syncMissionCatalog } from '../src/application/adminMissionActions';
import { firebaseAdminMissionGateway } from '../src/infrastructure/firebase/adminMissionActions';
import { adjustTeamScore } from '../src/application/adminScoreAdjustment';
import type { AdjustTeamScoreResult, ScoreAdjustmentReasonCode } from '../src/application/gameplayPorts';
import { firebaseAdminScoreAdjustmentGateway } from '../src/infrastructure/firebase/adminScoreAdjustmentActions';
import { prepareGameReset, executeGameReset } from '../src/application/gameReset';
import type { PrepareGameResetPreview } from '../src/application/gameplayPorts';
import { firebaseAdminGameResetGateway } from '../src/infrastructure/firebase/adminGameResetActions';
import { firebaseGameLogStore } from '../src/infrastructure/firebase/gameplayStores';
import { db } from '../src/infrastructure/firebase/firebaseClient';
import { subscribeEmergencyLocationProjections } from '../src/infrastructure/firebase/subscriptions';
import type { EmergencyLocationProjection } from '../types';
import EmergencyProjectionMap from './EmergencyProjectionMap';
import { doc, updateDoc, deleteDoc, setDoc } from 'firebase/firestore';

interface Props {
  config: GameConfig;
  setConfig: (update: GameConfig | ((prev: GameConfig) => GameConfig)) => Promise<void>;
  users: User[];
  missions: Mission[];
}

const AdminView: React.FC<Props> = ({ config, setConfig, users = [], missions = [] }) => {
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [scoreTeam, setScoreTeam] = useState<'A' | 'B'>('A');
  const [scoreDeltaInput, setScoreDeltaInput] = useState('');
  const [scoreReasonCode, setScoreReasonCode] = useState<ScoreAdjustmentReasonCode>('CORRECTION');
  const [scoreAdjustmentResult, setScoreAdjustmentResult] = useState<Extract<AdjustTeamScoreResult, { ok: true }> | null>(null);
  const [resetPreview, setResetPreview] = useState<PrepareGameResetPreview | null>(null);
  const [resetConfirmationText, setResetConfirmationText] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchDuration, setSearchDuration] = useState(10); 
  const [manualMissionId, setManualMissionId] = useState('');
  const [emergencyProjections, setEmergencyProjections] = useState<EmergencyLocationProjection[]>([]);
  const [projectionUnavailable, setProjectionUnavailable] = useState(false);
  const [resumingPlayerIds, setResumingPlayerIds] = useState<Set<string>>(new Set());
  const roleSwapBusyRef = useRef(false);
  const roleSwapRequestIdRef = useRef<string | null>(null);
  const resumeBusyRef = useRef(new Set<string>());
  const revealBusyRef = useRef(false);
  const revealRequestIdsRef = useRef<Partial<Record<AdminRevealScope, string>>>({});
  const missionBusyRef = useRef(false);
  const scoreBusyRef = useRef(false);
  const resetBusyRef = useRef(false);
  const resetRequestIdRef = useRef<string | null>(null);
  const pendingScoreRequestRef = useRef<{ key: string; requestId: string } | null>(null);
  const missionRequestIdsRef = useRef<Record<string, string>>({});
  const pendingMissionModeRef = useRef<{ mode: 'SAME' | 'DIFFERENT'; requestId: string } | null>(null);
  const emergencyPlayerIds = useMemo(
    () => users.filter(user => user.status === 'EMERGENCY' && (user.team === 'A' || user.team === 'B')).map(user => user.id),
    [users],
  );

  useEffect(() => {
    if (!isAuthorized) {
      setEmergencyProjections([]);
      setProjectionUnavailable(false);
      return;
    }
    return subscribeEmergencyLocationProjections(
      emergencyPlayerIds,
      projections => {
        setEmergencyProjections(projections);
        setProjectionUnavailable(false);
      },
      error => {
        console.error('Emergency location projection subscription failed:', error);
        setEmergencyProjections([]);
        setProjectionUnavailable(true);
      },
    );
  }, [isAuthorized, emergencyPlayerIds]);

  const PENALTY_LIST = [
    "次の新幹線の乗車可能時間を「1時間30分」に短縮せよ",
    "位置情報の公開が3時間の間「15分毎」になる（自己管理せよ）",
    "「在来線特急」の利用が3時間禁止！",
    "ミッション終了後「1時間」位置情報を常に開示せよ",
    "ミッション終了後「1時間」新幹線・特急の利用を禁止！",
    "GPSを30分間開示せよ（管理者サーチボタンを起動する）",
    "次に乗る列車を公開せよ(乗車駅、発車時刻、行先をLINEへ)",
    "その場で30分間待機せよ（タイマーを各自セット）",
    "最速で東京駅に向かえ",
    "優等列車の利用禁止（普通列車のみ移動可。快速・急行・特急等は不可）"
  ];

  const addGameLog = async (message: string, type: GameLog['type']): Promise<void> => {
    try {
      const newLog: GameLog = {
        id: Math.random().toString(36).substring(7),
        timestamp: Date.now(),
        message,
        type,
      };
      await firebaseGameLogStore.append(newLog, config.logs ?? []);
    } catch (error) {
      console.error('Log error:', error);
    }
  };

  const handlePhaseAction = async (action: 'START_DAY1' | 'PAUSE' | 'RESUME' | 'END_DAY1' | 'START_DAY2' | 'START_FINAL' | 'END_GAME'): Promise<void> => {
    if (isProcessing) return;
    if (!confirm(`フェーズ操作「${action}」を実行しますか？`)) return;
    setIsProcessing(true);
    try {
      const result = await transitionGamePhase({ action, requestId: crypto.randomUUID() }, firebaseAdminPhaseGateway);
      if (result.ok === false) alert(`フェーズ操作に失敗しました: ${result.reason}`);
    } catch {
      alert('フェーズ操作に失敗しました');
    } finally { 
      setIsProcessing(false); 
    }
  };
// 放送メッセージを消去する関数
  const handleClearBroadcast = async () => {
    try {
      setIsProcessing(true);
      await updateDoc(doc(db, 'game_config', 'current'), { 
        broadcastMessage: '', 
        broadcastTime: Date.now() 
      });
      alert('通知を消去しました');
    } catch {
      alert('消去に失敗しました');
    } finally {
      setIsProcessing(false);
    }
  };
  // AdminView.tsx の内部に追加

  const handleForceRoleSwap = async (): Promise<void> => {
    if (roleSwapBusyRef.current || isProcessing) return;
    if (!confirm('Team A と Team B の役割（鬼・逃走者）を強制的に入れ替えますか？\n※鬼側は30分間の待機状態になります。')) return;

    roleSwapBusyRef.current = true;
    setIsProcessing(true);
    const requestId = roleSwapRequestIdRef.current ?? crypto.randomUUID();
    roleSwapRequestIdRef.current = requestId;
    try {
      const result = await swapTeamRoles({ requestId }, firebaseAdminGameStateGateway);
      if (result.ok === false) {
        alert('交代に失敗しました。通信状態を確認して再試行してください。');
        return;
      }
      roleSwapRequestIdRef.current = null;
      alert(`交代完了。Team ${result.newOniTeam} が鬼になりました。`);
    } finally {
      roleSwapBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleResumePlayer = async (user: User): Promise<void> => {
    if (resumeBusyRef.current.has(user.id)) return;
    if (!confirm(`${user.name} をすべての待機状態から復帰させますか？`)) return;

    resumeBusyRef.current.add(user.id);
    setResumingPlayerIds(new Set(resumeBusyRef.current));
    try {
      const result = await resumePlayer({ targetId: user.id }, firebaseAdminGameStateGateway);
      if (result.ok === false) {
        alert('Playerの復帰に失敗しました。権限と通信状態を確認してください。');
      }
    } finally {
      resumeBusyRef.current.delete(user.id);
      setResumingPlayerIds(new Set(resumeBusyRef.current));
    }
  };
  const handleLocationReveal = async (scope: AdminRevealScope): Promise<void> => {
    if (revealBusyRef.current || isProcessing) return;
    const target = scope === 'GLOBAL' ? '全員' : `Team ${scope === 'TEAM_A' ? 'A' : 'B'}`;
    if (!confirm(`${target}の最新位置を ${searchDuration} 分間、スナップショット公開しますか？`)) return;

    revealBusyRef.current = true;
    setIsProcessing(true);
    const requestId = revealRequestIdsRef.current[scope] ?? crypto.randomUUID();
    revealRequestIdsRef.current[scope] = requestId;
    try {
      const result = await revealPlayerLocations({ scope, durationMinutes: searchDuration, requestId }, firebaseAdminRevealGateway);
      if (result.ok === false) {
        alert(result.reason === 'ZERO_VALID_LOCATIONS'
          ? '最新の有効な位置情報がありません。Playerの位置更新後に再試行してください。'
          : '位置公開に失敗しました。権限と通信状態を確認して再試行してください。');
        return;
      }
      delete revealRequestIdsRef.current[scope];
      alert(`${result.duplicate ? '既に実行済みです。' : '公開しました。'}\n公開: ${result.projectedCount}名 / 除外: ${result.skippedCount}名`);
    } finally {
      revealBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleSendRandomPenalty = async (targetTeam: 'A' | 'B') => {
    const penalty = PENALTY_LIST[Math.floor(Math.random() * PENALTY_LIST.length)];
    if (!confirm(`Team ${targetTeam} に罰: ${penalty}`)) return;
    setIsProcessing(true);
    try {
      await updateDoc(doc(db, 'game_config', 'current'), { 
        broadcastMessage: `【Team ${targetTeam} への罰】\n${penalty}`, 
        broadcastTime: Date.now() 
      });
      await addGameLog(`Team ${targetTeam} ペナルティ: ${penalty}`, 'SYSTEM');
      alert(`送信完了`);
    } catch (error) { 
      alert('失敗'); 
    } finally { 
      setIsProcessing(false); 
    }
  };

  const handleAdjustTeamScore = async (): Promise<void> => {
    if (scoreBusyRef.current || isProcessing) return;
    const delta = Number(scoreDeltaInput);
    if (!Number.isSafeInteger(delta) || delta === 0 || delta < -1000 || delta > 1000) {
      alert('補正値は -1000〜1000 の0以外の整数で入力してください。');
      return;
    }
    const reasonLabels: Record<ScoreAdjustmentReasonCode, string> = {
      CORRECTION: 'スコア訂正', BONUS: '運営ボーナス', PENALTY: '運営ペナルティ', OTHER: 'その他の運営調整',
    };
    if (!confirm(`Team ${scoreTeam} を ${delta > 0 ? '+' : ''}${delta}pt 補正しますか？\n理由: ${reasonLabels[scoreReasonCode]}`)) return;
    const key = `${scoreTeam}:${delta}:${scoreReasonCode}`;
    const requestId = pendingScoreRequestRef.current?.key === key
      ? pendingScoreRequestRef.current.requestId
      : crypto.randomUUID();
    pendingScoreRequestRef.current = { key, requestId };
    scoreBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await adjustTeamScore({ team: scoreTeam, delta, reasonCode: scoreReasonCode, requestId }, firebaseAdminScoreAdjustmentGateway);
      if (result.ok === false) {
        alert(`スコア補正に失敗しました: ${result.reason}`);
        return;
      }
      pendingScoreRequestRef.current = null;
      setScoreAdjustmentResult(result);
      setScoreDeltaInput('');
    } finally {
      scoreBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const missionRequestId = (key: string): string => {
    missionRequestIdsRef.current[key] ??= crypto.randomUUID();
    return missionRequestIdsRef.current[key];
  };

  const handleToggleMissionMode = async (): Promise<void> => {
    if (missionBusyRef.current || isProcessing) return;
    const pending = pendingMissionModeRef.current;
    const next = pending?.mode ?? (config.missionMode === 'SAME' ? 'DIFFERENT' : 'SAME');
    const requestId = pending?.requestId ?? crypto.randomUUID();
    pendingMissionModeRef.current ??= { mode: next, requestId };
    missionBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await setMissionMode({ mode: next, requestId }, firebaseAdminMissionGateway);
      if (result.ok === false) {
        alert(`モード切り替えに失敗しました: ${result.reason}`);
        return;
      }
      pendingMissionModeRef.current = null;
      if (!result.changed) alert('配信モードは変更されていません。');
    } finally {
      missionBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleManualAssign = async (team: 'A' | 'B'): Promise<void> => {
    if (missionBusyRef.current || isProcessing) return;
    if (!manualMissionId) return alert('ミッションを選択してください');
    if (!confirm(`Team ${team} に指定ミッションを配信しますか？`)) return;
    const target = team === 'A' ? 'TEAM_A' : 'TEAM_B';
    const key = `manual:${target}:${manualMissionId}`;
    missionBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await assignMissions({ strategy: 'MANUAL', target, missionId: manualMissionId, requestId: missionRequestId(key) }, firebaseAdminMissionGateway);
      if (result.ok === false) {
        alert(`ミッション配信に失敗しました: ${result.reason}`);
        return;
      }
      delete missionRequestIdsRef.current[key];
      alert('配信完了');
    } finally {
      missionBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleShuffleMissions = async (): Promise<void> => {
    if (missionBusyRef.current || isProcessing) return;
    if (!confirm('サーバーで選んだミッションを両チームへ配信しますか？')) return;
    const key = 'random-assignment';
    missionBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await assignMissions({ strategy: 'RANDOM', target: 'BOTH', requestId: missionRequestId(key) }, firebaseAdminMissionGateway);
      if (result.ok === false) {
        alert(`ランダム配信に失敗しました: ${result.reason}`);
        return;
      }
      delete missionRequestIdsRef.current[key];
      alert(`ミッションを配信しました${result.duplicate ? '（再送結果）' : ''}`);
    } finally {
      missionBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleSyncMissionCatalog = async (): Promise<void> => {
    if (missionBusyRef.current || isProcessing || !confirm('Normal / Final Mission catalogを安全に同期しますか？未知のMissionは削除されません。')) return;
    const key = 'catalog-sync';
    missionBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await syncMissionCatalog({ requestId: missionRequestId(key) }, firebaseAdminMissionGateway);
      if (result.ok === false) {
        alert(`ミッションcatalog同期に失敗しました: ${result.reason}`);
        return;
      }
      delete missionRequestIdsRef.current[key];
      alert(`同期完了: 作成 ${result.createdCount} / 更新 ${result.updatedCount} / 変更なし ${result.unchangedCount}（管理対象 ${result.totalManagedCount}）`);
    } finally {
      missionBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handlePrepareGameReset = async (): Promise<void> => {
    if (resetBusyRef.current || isProcessing) return;
    resetBusyRef.current = true;
    setIsProcessing(true);
    setResetPreview(null);
    setResetConfirmationText('');
    setResetError(null);
    setResetSuccess(null);
    resetRequestIdRef.current = null;
    try {
      const result = await prepareGameReset({}, firebaseAdminGameResetGateway);
      if (result.ok === false) {
        setResetError(`Reset Previewに失敗しました: ${result.reason}`);
        return;
      }
      setResetPreview(result.preview);
    } finally {
      resetBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleExecuteGameReset = async (): Promise<void> => {
    if (resetBusyRef.current || isProcessing || !resetPreview || resetConfirmationText !== 'RESET') return;
    resetBusyRef.current = true;
    setIsProcessing(true);
    setResetError(null);
    try {
      resetRequestIdRef.current ??= crypto.randomUUID();
      const result = await executeGameReset({
        confirmationToken: resetPreview.confirmationToken,
        requestId: resetRequestIdRef.current,
      }, firebaseAdminGameResetGateway);
      if (result.ok === false) {
        setResetError(`Resetは実行されませんでした: ${result.reason}`);
        return;
      }
      resetRequestIdRef.current = null;
      setResetSuccess(`新しいSession ${result.newSessionId} を開始しました`);
    } finally {
      resetBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  if (!isAuthorized) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-900 p-6">
        <div className="w-full max-w-xs bg-slate-800 p-8 rounded-3xl text-center shadow-2xl border border-slate-700">
          <Lock size={40} className="mx-auto mb-6 text-blue-500" />
          <form onSubmit={async e => {
            e.preventDefault();
            try {
              const authorized = await signInAdmin(emailInput, passwordInput);
              if (!authorized) {
                alert('このアカウントには管理者権限がありません');
                return;
              }
              setIsAuthorized(true);
            } catch {
              alert('管理者ログインに失敗しました');
            }
          }}>
            <label htmlFor="admin-email" className="block text-xs font-bold text-slate-400 mb-2 uppercase tracking-widest">Admin Email</label>
            <input id="admin-email" type="email" value={emailInput} onChange={e => setEmailInput(e.target.value)} className="w-full p-4 bg-slate-700 rounded-2xl text-white text-center font-bold mb-3 outline-none border-2 border-transparent focus:border-blue-500" placeholder="admin@example.com" required />
            <label htmlFor="admin-pass" className="block text-xs font-bold text-slate-400 mb-2 uppercase tracking-widest">Password</label>
            <input id="admin-pass" type="password" value={passwordInput} onChange={e => setPasswordInput(e.target.value)} className="w-full p-4 bg-slate-700 rounded-2xl text-white text-center font-bold mb-4 outline-none border-2 border-transparent focus:border-blue-500" placeholder="PASSWORD" required />
            <button type="submit" className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black shadow-lg">SIGN IN</button>
          </form>
        </div>
      </div>
    );
  }

  const currentMissionA = MISSIONS.find(m => m.id === config.activeMissionA);
  const currentMissionB = MISSIONS.find(m => m.id === config.activeMissionB);

  return (
    <div className="p-4 pb-32 space-y-6 text-slate-800 bg-slate-100 min-h-screen">
      
      {/* 1. フェーズ管理 */}
      <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
        <h3 className="font-black flex items-center gap-2 mb-4 text-slate-700 uppercase tracking-tighter"><Play size={20} /> Phase Control</h3>
        <div className="grid grid-cols-2 gap-2">
          {config.gameStatus === 'PRE_GAME' && <button onClick={() => handlePhaseAction('START_DAY1')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-[10px] bg-slate-100 text-slate-600">DAY 1 開始</button>}
          {config.gameStatus === 'DAY1_ACTIVE' && <><button onClick={() => handlePhaseAction('PAUSE')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-[10px] bg-slate-100 text-slate-600">一時停止</button><button onClick={() => handlePhaseAction('END_DAY1')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-[10px] bg-slate-100 text-slate-600">DAY 1 終了</button></>}
          {config.gameStatus === 'DAY1_PAUSED' && <button onClick={() => handlePhaseAction('RESUME')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-[10px] bg-slate-100 text-slate-600">DAY 1 再開</button>}
          {config.gameStatus === 'DAY1_ENDED' && <button onClick={() => handlePhaseAction('START_DAY2')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-[10px] bg-slate-100 text-slate-600">DAY 2 開始</button>}
          {config.gameStatus === 'DAY2_ACTIVE' && <><button onClick={() => handlePhaseAction('PAUSE')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-[10px] bg-slate-100 text-slate-600">一時停止</button><button onClick={() => handlePhaseAction('START_FINAL')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-[10px] bg-slate-100 text-slate-600">Final 開始</button></>}
          {config.gameStatus === 'DAY2_PAUSED' && <button onClick={() => handlePhaseAction('RESUME')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-[10px] bg-slate-100 text-slate-600">DAY 2 再開</button>}
          {config.gameStatus === 'FINAL_MISSION' && <button onClick={() => handlePhaseAction('END_GAME')} disabled={isProcessing} className="p-3 col-span-2 bg-red-600 text-white rounded-xl font-black text-xs mt-2 shadow-lg">GAME OVER / RESULT</button>}
        </div>
      </section>
          {/* AdminView.tsx の return 内 */}

      <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
        <h3 className="font-black flex items-center gap-2 mb-4 text-slate-700 uppercase tracking-tighter">
          <RefreshCw size={20} /> Role Management
        </h3>
        <div className="flex flex-col gap-3">
          <div className="flex justify-between items-center px-4 py-2 bg-slate-50 rounded-2xl border border-slate-100">
            <div className="text-[10px] font-black text-slate-500 uppercase">Current Status</div>
            <div className="flex gap-2 font-bold text-xs">
              <span className={config.teamARole === 'ONI' ? 'text-red-600' : 'text-blue-600'}>A:{config.teamARole}</span>
              <span className="text-slate-300">/</span>
              <span className={config.teamBRole === 'ONI' ? 'text-red-600' : 'text-blue-600'}>B:{config.teamBRole}</span>
            </div>
          </div>
          
          <button
            onClick={handleForceRoleSwap}
            disabled={isProcessing}
            className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black text-sm shadow-lg flex items-center justify-center gap-2 active:scale-95 transition-all"
          >
            <RefreshCw size={18} /> 攻守を強制交代する
          </button>
        </div>
      </section>



      {/* 1.5 特殊操作 */}
      <section className="bg-amber-500 p-6 rounded-3xl shadow-xl text-white">
        <h3 className="font-black flex items-center gap-2 mb-4 uppercase tracking-tighter"><MapPin size={20} /> Special Command</h3>
        <div className="space-y-4">
        <div className="bg-white/10 p-3 rounded-2xl border border-white/20">
            <label className="block text-[9px] font-black uppercase opacity-70 mb-1">Next Reveal Time</label>
            <div className="text-[10px] font-black text-white/70 mb-2">
              {config.nextRevealTime
                ? `現在: ${new Date(config.nextRevealTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : '未設定'}
            </div>
            
            <div className="flex items-center gap-2">  
              <input
                type="time"
                onChange={async (e) => {
                  if (!e.target.value) return;
                  const [h, m] = e.target.value.split(':').map(Number);
                  const target = new Date();
                  target.setHours(h, m, 0, 0);
                  if (target.getTime() < Date.now()) target.setDate(target.getDate() + 1);
                  await updateDoc(doc(db, 'game_config', 'current'), { nextRevealTime: target.getTime() });
                  alert(`次の位置公開を ${e.target.value} にセットしました`);
                }}
                className="w-full bg-white text-amber-600 font-black px-3 py-2 rounded-xl outline-none text-center"
              />
            </div>
          </div>
        <div className="bg-white/10 p-3 rounded-2xl border border-white/20">
            <label htmlFor="duration-input" className="block text-[9px] font-black uppercase opacity-70 mb-1">Search Duration (Min)</label>            <div className="flex items-center gap-3">
              <input id="duration-input" type="number" min={1} max={30} step={1} value={searchDuration} onChange={(e) => setSearchDuration(Math.min(30, Math.max(1, parseInt(e.target.value) || 1)))} className="w-20 bg-white text-amber-600 font-black px-3 py-2 rounded-xl outline-none text-center" />
              <span className="font-black text-xs">分間に設定中</span>
            </div>
          </div>
          <button onClick={() => void handleLocationReveal('GLOBAL')} disabled={isProcessing} className="w-full py-4 bg-white text-amber-600 rounded-2xl font-black text-lg shadow-lg flex items-center justify-center gap-2">全員スナップショット公開</button>
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/20">
            <button onClick={() => void handleLocationReveal('TEAM_A')} disabled={isProcessing} className="py-3 bg-red-600 text-white rounded-2xl font-black text-[10px] shadow-lg border border-white/10">🔍 Team A サーチ</button>
            <button onClick={() => void handleLocationReveal('TEAM_B')} disabled={isProcessing} className="py-3 bg-blue-600 text-white rounded-2xl font-black text-[10px] shadow-lg border border-white/10">🔍 Team B サーチ</button>
          </div>
        </div>
      </section>

      {/* 1.6 ランダムペナルティ */}
      <section className="bg-slate-800 p-6 rounded-3xl shadow-xl text-white border-2 border-red-500/30">
        <h3 className="font-black flex items-center gap-2 mb-1 text-red-500"><AlertTriangle size={20} /> Penalty Roulette</h3>
        <p className="text-[10px] text-white/50 font-bold mb-4 uppercase">ミッション失敗時などのランダム罰</p>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => handleSendRandomPenalty('A')} disabled={isProcessing} className="py-4 bg-red-600/20 text-red-500 rounded-2xl font-black text-xs border border-red-600/50 active:bg-red-600">Team A へ</button>
          <button onClick={() => handleSendRandomPenalty('B')} disabled={isProcessing} className="py-4 bg-blue-600/20 text-blue-500 rounded-2xl font-black text-xs border border-blue-600/50 active:bg-blue-600">Team B へ</button>
        </div>

        {/* --- これを追加 --- */}
        {config.broadcastMessage && (
          <button 
            onClick={handleClearBroadcast}
            disabled={isProcessing}
            className="w-full py-2 bg-white/10 text-white/40 rounded-xl font-bold text-[10px] border border-white/5 flex items-center justify-center gap-2 active:bg-white/20"
          >
            <XCircle size={14} /> 表示中の通知を全員の画面から消去
          </button>
        )}

      </section>

      {/* 2. ミッション管理 */}
      <section className="bg-indigo-600 p-6 rounded-3xl shadow-xl text-white">
        <h3 className="font-black flex items-center gap-2 mb-4"><Shuffle size={20} /> Mission Control</h3>
        
        <button 
          onClick={handleToggleMissionMode}
          disabled={isProcessing}
          className="w-full mb-4 py-2 rounded-xl border border-white/30 text-[11px] font-black flex items-center justify-center gap-2 bg-white/10 active:bg-white/20 transition-all disabled:opacity-50"
        >
          配信モード：{config.missionMode === 'SAME' ? '🔗 両チーム同一' : '🔀 チーム別'}
        </button>

        <div className="space-y-2 mb-4">
          {(['A', 'B'] as const).map(t => {
            const m = t === 'A' ? currentMissionA : currentMissionB;
            return (
              <div key={t} className="bg-white/10 rounded-2xl p-3 flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[9px] font-black text-white/50 uppercase">Team {t} Status</div>
                  <p className="text-xs font-bold text-white leading-snug">{m ? m.title : '未配信'}</p>
                </div>
                <span title="Mission CompletionのUndoは行いません。Team Score欄の監査付き補正を使用してください" className="shrink-0 px-2 py-1 bg-white/10 rounded-lg text-[9px] font-bold text-white/50">Undo不可</span>
              </div>
            );
          })}
        </div>

        <button onClick={handleShuffleMissions} disabled={isProcessing} className="w-full py-4 bg-white text-indigo-700 rounded-2xl font-black text-lg shadow-lg mb-6 active:scale-95 transition-all">🎲 ランダム配信実行</button>

        <div className="pt-4 border-t border-white/20">
          <label htmlFor="mission-select" className="block text-[10px] font-black opacity-70 mb-2 uppercase tracking-widest text-center">Manual Mission Assign</label>
          <select id="mission-select" value={manualMissionId} onChange={(e) => setManualMissionId(e.target.value)} className="w-full p-3 bg-white text-slate-800 rounded-xl text-xs font-bold mb-3 outline-none">
            <option value="">ミッションを選択してください</option>
            {MISSIONS.map(m => <option key={m.id} value={m.id}>[{m.points}pt] {m.title}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => handleManualAssign('A')} disabled={isProcessing} className="py-2 bg-white/20 text-white rounded-xl text-[10px] font-black border border-white/30 active:bg-white/40 disabled:opacity-50">Aに指定配信</button>
            <button onClick={() => handleManualAssign('B')} disabled={isProcessing} className="py-2 bg-white/20 text-white rounded-xl text-[10px] font-black border border-white/30 active:bg-white/40 disabled:opacity-50">Bに指定配信</button>
          </div>
        </div>
      </section>


      {projectionUnavailable && (
        <p role="status" className="rounded-2xl bg-amber-100 p-4 text-sm font-bold text-amber-900">
          Emergency位置を読み込めません。最新位置は管理画面で確認できない場合があります。
        </p>
      )}
      <EmergencyProjectionMap projections={emergencyProjections} users={users} />

      {/* 3. プレイヤー管理 */}
      <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
        <h3 className="font-black flex items-center gap-2 mb-4 text-slate-700 uppercase tracking-tighter"><Users size={20} /> Players ({users.length})</h3>
        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center">
              <div>
                <div className="text-sm font-black text-slate-800">{u.name}</div>
                <div className="flex gap-1 mt-1">
                  <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${u.team === 'A' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'}`}>TEAM {u.team}</span>
                  <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">{u.role}</span>
                  <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${u.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>{u.status}</span>
                </div>
              </div>
            <div className="flex gap-1.5">
                {/* 1. 【復活】役割の個別入れ替えボタン（シールド） */}
                <button 
                  onClick={async () => { 
                    await setDoc(doc(db, 'users', u.id), { 
                      role: u.role === 'ONI' ? 'RUNNER' : 'ONI' 
                    }, { merge: true }); 
                  }} 
                  className={`p-2 rounded-xl border ${u.role === 'ONI' ? 'bg-slate-900 text-white' : 'bg-white text-slate-400'}`}
                >
                  <Shield size={16} />
                </button>

                {/* 2. すべての待機状態から復帰させるボタン */}
                <button
                  onClick={() => void handleResumePlayer(u)}
                  disabled={resumingPlayerIds.has(u.id)}
                  className="p-2 bg-emerald-50 text-emerald-600 rounded-xl border border-emerald-100 active:bg-emerald-100 disabled:opacity-50"
                >
                  <RefreshCw size={16} />
                </button>

                {/* 3. 削除ボタン */}
                <button 
                  onClick={async () => { 
                    if (confirm('削除しますか？')) { 
                      await deleteDoc(doc(db, 'users', u.id)); 
                    } 
                  }} 
                  className="p-2 bg-red-50 text-red-500 rounded-xl border border-red-100"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 4. スコア管理 */}
      <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
        <h3 className="font-black mb-4 flex items-center gap-2 text-slate-700 uppercase tracking-tighter"><Trophy size={20} /> Team Score</h3>
        <div className="grid grid-cols-2 gap-4 mb-4">
          {(['A', 'B'] as const).map(t => (
            <div key={t} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 text-center">
              <div className="text-[10px] font-black text-slate-400 mb-1 uppercase">Team {t}</div>
              <div className="text-2xl font-black text-slate-800">{t === 'A' ? (config.teamAScore ?? 0) : (config.teamBScore ?? 0)} <span className="text-xs">pt</span></div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-[10px] font-black text-slate-500">対象チーム
            <select aria-label="補正対象チーム" value={scoreTeam} onChange={event => setScoreTeam(event.target.value as 'A' | 'B')} className="mt-1 w-full p-2 border rounded-xl text-sm text-slate-800">
              <option value="A">Team A</option><option value="B">Team B</option>
            </select>
          </label>
          <label className="text-[10px] font-black text-slate-500">増減値（-1000〜1000）
            <input aria-label="スコア増減値" type="number" step="1" value={scoreDeltaInput} onChange={event => setScoreDeltaInput(event.target.value)} className="mt-1 w-full p-2 border rounded-xl text-sm text-slate-800" placeholder="例: 5 / -3" />
          </label>
          <label className="col-span-2 text-[10px] font-black text-slate-500">理由
            <select aria-label="補正理由" value={scoreReasonCode} onChange={event => setScoreReasonCode(event.target.value as ScoreAdjustmentReasonCode)} className="mt-1 w-full p-2 border rounded-xl text-sm text-slate-800">
              <option value="CORRECTION">スコア訂正</option><option value="BONUS">運営ボーナス</option><option value="PENALTY">運営ペナルティ</option><option value="OTHER">その他の運営調整</option>
            </select>
          </label>
        </div>
        <button type="button" onClick={() => void handleAdjustTeamScore()} disabled={isProcessing} className="mt-3 w-full py-3 bg-indigo-600 text-white rounded-xl font-black disabled:opacity-50">スコア補正を実行</button>
        {scoreAdjustmentResult && <p role="status" className="mt-3 text-center text-sm font-bold text-emerald-700">Team {scoreAdjustmentResult.team}: {scoreAdjustmentResult.previousScore} → {scoreAdjustmentResult.nextScore} pt{scoreAdjustmentResult.duplicate ? '（再送結果）' : ''}</p>}
      </section>

      <div className="space-y-4">
        <button onClick={handleSyncMissionCatalog} disabled={isProcessing} className="w-full py-4 bg-blue-50 text-blue-600 rounded-2xl font-black text-xs border border-blue-100 mb-2 uppercase tracking-widest active:bg-blue-100 disabled:opacity-50">🔄 ミッションDB同期</button>
        <section className="rounded-2xl border-2 border-red-100 bg-red-50 p-4 text-slate-800">
          <h3 className="flex items-center gap-2 font-black text-red-700"><AlertTriangle size={18} /> Master Reset Preview</h3>
          <p className="mt-2 text-xs font-bold text-slate-600">Previewのみです。実行後のロールバックはできません。Session対応が完了するまでResetは実行できません。</p>
          <button type="button" onClick={() => void handlePrepareGameReset()} disabled={isProcessing} className="mt-3 w-full rounded-xl bg-red-600 py-3 font-black text-white disabled:opacity-50">{isProcessing ? 'Previewを取得中…' : 'Reset Previewを取得'}</button>
          {resetPreview && <div className="mt-3 space-y-2 rounded-xl bg-white p-3 text-xs">
            <p>対象Player: <strong>{resetPreview.participantCount}</strong></p>
            <p>Private locations: <strong>{resetPreview.privateLocationCount}</strong></p>
            <p>Exposed locations: <strong>{resetPreview.exposedLocationCount}</strong></p>
            <p>Emergency projections: <strong>{resetPreview.emergencyProjectionCount}</strong></p>
            <p>推定write数: <strong>{resetPreview.estimatedWriteCount}</strong> / 450</p>
            <p>Current Session: <strong>{resetPreview.currentSessionId ?? 'legacy (未設定)'}</strong></p>
            <p>提案Session: <strong>{resetPreview.proposedSessionId}</strong></p>
            <p>Token期限: <strong>{new Date(resetPreview.expiresAt).toLocaleString()}</strong>（期限切れの場合はPreviewを再取得）</p>
            {resetPreview.warningCodes.map(code => <p key={code} role="alert" className="font-bold text-amber-700">警告: {code}</p>)}
            <label className="block pt-2 font-bold">確認のため RESET と入力
              <input aria-label="Reset typed confirmation" value={resetConfirmationText} onChange={event => setResetConfirmationText(event.target.value)} className="mt-1 w-full rounded-lg border p-2" />
            </label>
            <button type="button" onClick={() => void handleExecuteGameReset()} disabled className="mt-2 w-full rounded-xl bg-slate-300 py-3 font-black text-slate-600">Reset実行は無効です</button>
          </div>}
          {resetError && <p role="alert" className="mt-3 text-sm font-bold text-red-700">{resetError}</p>}
          {resetSuccess && <p role="status" className="mt-3 text-sm font-bold text-emerald-700">{resetSuccess}</p>}
        </section>
      </div>
    </div>
  );
};

export default AdminView;
