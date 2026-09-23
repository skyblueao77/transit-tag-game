import React, { useState } from 'react';
import { GameConfig, User, GameLog, GameStatus, Mission , Role} from '../types';
import { INITIAL_GAME_CONFIG, MISSIONS, FINAL_MISSIONS, getRandomFinalMission } from '../constants';
import {
  Users, Lock, Trash2, Save, Shield, Trophy, Play,
  AlertTriangle, Shuffle, XCircle, Flag, MapPin,
  RefreshCw 
} from 'lucide-react';
import { auth, db } from '../firebase';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { doc, updateDoc, collection, getDocs, writeBatch, deleteDoc, setDoc, getDoc } from 'firebase/firestore';

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
  const [teamAScoreInput, setTeamAScoreInput] = useState<number | null>(null);
  const [teamBScoreInput, setTeamBScoreInput] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchDuration, setSearchDuration] = useState(10); 
  const [manualMissionId, setManualMissionId] = useState('');

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
      await updateDoc(doc(db, 'game_config', 'current'), {
        logs: [newLog, ...(config.logs ?? [])].slice(0, 200),
      });
    } catch (error) {
      console.error('Log error:', error);
    }
  };

  const handleUpdateStatus = async (newStatus: GameStatus): Promise<void> => {
    if (isProcessing) return;
    if (!confirm(`フェーズを「${newStatus}」に変更しますか？`)) return;
    setIsProcessing(true);
    const updates: Record<string, any> = { gameStatus: newStatus };
    
    if (newStatus === 'PRE_GAME') {
      Object.assign(updates, { day: 1, isFinalMissionActive: false, isGameOver: false, startTime: 0 });
    } else if (newStatus === 'GAME_OVER') {
      updates.isGameOver = true;
    } else if (newStatus === 'DAY1_ACTIVE') {
      if (!config.startTime || config.startTime === 0) {
      updates.startTime = Date.now();
      }
    } else if (newStatus === 'DAY2_ACTIVE') {
      if (!config.startTime || config.startTime === 0) {
      updates.startTime = Date.now();
      }
    } else if (newStatus === 'FINAL_MISSION') {
      const finalM = getRandomFinalMission();
      updates.isFinalMissionActive = true;
      updates.activeFinalMissionId = finalM.id;
      updates.finalMissionEndTime = Date.now() + 2 * 60 * 60 * 1000;
      await addGameLog(`最終ミッション選出: ${finalM.title}`, 'SYSTEM');
    }


    try {
      await updateDoc(doc(db, 'game_config', 'current'), updates);
      await addGameLog(`フェーズ変更: ${newStatus}`, 'SYSTEM');
    } catch (error) { 
      alert('更新に失敗しました'); 
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

  const handleForceRoleSwap = async () => {
  if (!confirm("Team A と Team B の役割（鬼・逃走者）を強制的に入れ替えますか？\n※鬼側は30分間の待機状態になります。")) return;
  
  setIsProcessing(true);
  try {
    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;

    // 現在の役割を反転
    const newRoleA: Role = config.teamARole === 'ONI' ? 'RUNNER' : 'ONI';
    const newRoleB: Role = newRoleA === 'ONI' ? 'RUNNER' : 'ONI';

    // 1. GameConfig の更新
    await updateDoc(doc(db, 'game_config', 'current'), {
      teamARole: newRoleA,
      teamBRole: newRoleB,
      nextRevealTime: now + thirtyMinutes,
    });

    // 2. 全ユーザーのステータスを一括更新（Batch処理）
    const batch = writeBatch(db);
    const oniTeam = newRoleA === 'ONI' ? 'A' : 'B';

    users.forEach(u => {
      if (u.team === oniTeam) {
        // 新しく鬼になったチーム：待機モードへ
        batch.update(doc(db, 'users', u.id), {
          status: 'WAITING',
          waitingUntil: now + thirtyMinutes,
          invincibleUntil: 0, // 無敵解除
        });
      } else if (u.team !== 'ADMIN') {
        // 新しく逃走者になったチーム：アクティブへ
        batch.update(doc(db, 'users', u.id), {
          status: 'ACTIVE',
          waitingUntil: 0,
        });
      }
    });

    await batch.commit();
    await addGameLog(`【運営操作】攻守を強制的に交代しました (新・鬼: Team ${oniTeam})`, 'SYSTEM');
    alert(`交代完了。Team ${oniTeam} が鬼になりました。`);
  } catch (error) {
    console.error(error);
    alert('交代に失敗しました');
  } finally {
    setIsProcessing(false);
  }
};
  const handleForceLocationReveal = async () => {
    if (!confirm(`全員を ${searchDuration} 分間、固定公開しますか？`)) return;
    setIsProcessing(true);
    try {
      const revealUntil = Date.now() + searchDuration * 60 * 1000;
      const batch = writeBatch(db);
      const privateLocations = await Promise.all(users.map(async user => {
        const snapshot = await getDoc(doc(db, 'privateLocations', user.id));
        if (!snapshot.exists()) return null;
        const location = snapshot.data();
        if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
        return { userId: user.id, latitude: location.latitude as number, longitude: location.longitude as number };
      }));
      privateLocations.forEach(location => {
        if (!location) return;
        batch.update(doc(db, 'users', location.userId), {
          exposedLat: location.latitude,
          exposedLng: location.longitude,
          locationExposedUntil: revealUntil
        });
      });
      batch.update(doc(db, 'game_config', 'current'), { locationRevealUntil: revealUntil });
      await batch.commit();
      await addGameLog(`一斉スナップショット（${searchDuration}分間）`, 'SYSTEM');
      alert("公開しました");
    } catch (error) { 
      console.error(error); 
    } finally { 
      setIsProcessing(false); 
    }
  };

  const handleTeamLocationReveal = async (targetTeam: 'A' | 'B') => {
    if (!confirm(`Team ${targetTeam} を ${searchDuration} 分間、リアルタイム開示しますか？`)) return;
    setIsProcessing(true);
    try {
      const revealUntil = Date.now() + searchDuration * 60 * 1000;
      await updateDoc(doc(db, 'game_config', 'current'), { [`team${targetTeam}RevealUntil`]: revealUntil });
      await addGameLog(`Team ${targetTeam} リアルタイムサーチ（${searchDuration}分）`, 'SYSTEM');
      alert("サーチ開始");
    } catch (error) { 
      alert('失敗'); 
    } finally { 
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

  const handleToggleMissionMode = async (): Promise<void> => {
    const next = config.missionMode === 'SAME' ? 'DIFFERENT' : 'SAME';
    try {
      await updateDoc(doc(db, 'game_config', 'current'), { missionMode: next });
    } catch {
      alert('モード切り替えに失敗しました。');
    }
  };

  const handleManualAssign = async (team: 'A' | 'B') => {
    if (!manualMissionId) return alert('ミッションを選択してください');
    if (!confirm(`Team ${team} に指定ミッションを配信しますか？`)) return;
    try {
      const field = team === 'A' ? 'activeMissionA' : 'activeMissionB';
      await updateDoc(doc(db, 'game_config', 'current'), { [field]: manualMissionId });
      await addGameLog(`Team ${team} に指定ミッション配信`, 'SYSTEM');
      alert('配信完了');
    } catch { 
      alert('失敗'); 
    }
  };

  const handleShuffleMissions = async (): Promise<void> => {
    if (MISSIONS.length === 0) return alert('ミッションデータがありません');
    try {
      setIsProcessing(true);
      const pool = [...MISSIONS];
      const m1 = pool[Math.floor(Math.random() * pool.length)];
      let m2 = pool[Math.floor(Math.random() * pool.length)];
      
      if (config.missionMode === 'DIFFERENT' && pool.length > 1) {
        while (m2.id === m1.id) { 
          m2 = pool[Math.floor(Math.random() * pool.length)]; 
        }
      }

      await updateDoc(doc(db, 'game_config', 'current'), { 
        activeMissionA: m1.id, 
        activeMissionB: config.missionMode === 'SAME' ? m1.id : m2.id 
      });

      await addGameLog(`ランダムミッション配信 (${config.missionMode})`, 'MISSION');
      alert("ミッションを配信しました");
    } catch { 
      alert('失敗'); 
    } finally { 
      setIsProcessing(false); 
    }
  };

  const handleResetAllData = async (): Promise<void> => {
    if (!confirm('【⚠️警告】全データを消去しますか？')) return;
    if (!auth.currentUser || !(await getDoc(doc(db, 'admins', auth.currentUser.uid))).exists()) {
      alert('管理者権限が確認できません。');
      return;
    }
    try {
      setIsProcessing(true);
      const batch = writeBatch(db);
      const userSnaps = await getDocs(collection(db, 'users'));
      userSnaps.docs.forEach(uDoc => batch.delete(uDoc.ref));
      batch.set(doc(db, 'game_config', 'current'), { 
        ...INITIAL_GAME_CONFIG, 
        logs: [], 
        teamAScore: 0, 
        teamBScore: 0, 
        gameStatus: 'PRE_GAME' 
      });
      await batch.commit(); 
      window.location.reload();
    } catch { 
      alert('失敗'); 
    } finally { 
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
              const credential = await signInWithEmailAndPassword(auth, emailInput, passwordInput);
              const adminDoc = await getDoc(doc(db, 'admins', credential.user.uid));
              if (!adminDoc.exists()) {
                await auth.signOut();
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
          {(['PRE_GAME', 'DAY1_ACTIVE', 'DAY1_PAUSED', 'DAY1_ENDED', 'DAY2_ACTIVE', 'FINAL_MISSION'] as GameStatus[]).map(status => (
            <button key={status} onClick={() => handleUpdateStatus(status)} disabled={isProcessing} className={`p-3 rounded-xl font-bold text-[10px] ${config.gameStatus === status ? 'bg-slate-900 text-white shadow-inner' : 'bg-slate-100 text-slate-600'}`}>{status}</button>
          ))}
          <button onClick={() => handleUpdateStatus('GAME_OVER')} disabled={isProcessing} className="p-3 col-span-2 bg-red-600 text-white rounded-xl font-black text-xs mt-2 shadow-lg">GAME OVER / RESULT</button>
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
              <input id="duration-input" type="number" value={searchDuration} onChange={(e) => setSearchDuration(Math.max(1, parseInt(e.target.value) || 1))} className="w-20 bg-white text-amber-600 font-black px-3 py-2 rounded-xl outline-none text-center" />
              <span className="font-black text-xs">分間に設定中</span>
            </div>
          </div>
          <button onClick={handleForceLocationReveal} disabled={isProcessing} className="w-full py-4 bg-white text-amber-600 rounded-2xl font-black text-lg shadow-lg flex items-center justify-center gap-2">全員スナップショット公開</button>
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-white/20">
            <button onClick={() => handleTeamLocationReveal('A')} disabled={isProcessing} className="py-3 bg-red-600 text-white rounded-2xl font-black text-[10px] shadow-lg border border-white/10">🔍 Team A サーチ</button>
            <button onClick={() => handleTeamLocationReveal('B')} disabled={isProcessing} className="py-3 bg-blue-600 text-white rounded-2xl font-black text-[10px] shadow-lg border border-white/10">🔍 Team B サーチ</button>
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
          className="w-full mb-4 py-2 rounded-xl border border-white/30 text-[11px] font-black flex items-center justify-center gap-2 bg-white/10 active:bg-white/20 transition-all"
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
                <button onClick={async () => {
                  const missionId = t === 'A' ? config.activeMissionA : config.activeMissionB;
                  if (!missionId) return;
                  if (confirm(`Team ${t} の完了を取り消しますか？`)) {
                    const mission = MISSIONS.find(mi => mi.id === missionId);
                    const pts = mission?.points ?? 0;
                    const currentScore = t === 'A' ? (config.teamAScore ?? 0) : (config.teamBScore ?? 0);
                    await updateDoc(doc(db, 'game_config', 'current'), { 
                      [t === 'A' ? 'teamAScore' : 'teamBScore']: Math.max(0, currentScore - pts) 
                    });
                  }
                }} className="shrink-0 p-1.5 bg-white/10 rounded-lg active:bg-red-500"><XCircle size={14} /></button>
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
            <button onClick={() => handleManualAssign('A')} className="py-2 bg-white/20 text-white rounded-xl text-[10px] font-black border border-white/30 active:bg-white/40">Aに指定配信</button>
            <button onClick={() => handleManualAssign('B')} className="py-2 bg-white/20 text-white rounded-xl text-[10px] font-black border border-white/30 active:bg-white/40">Bに指定配信</button>
          </div>
        </div>
      </section>


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
                  onClick={async () => { 
                    if (confirm(`${u.name} をすべての待機状態から復帰させますか？`)) { 
                      await setDoc(doc(db, 'users', u.id), { 
                        status: 'ACTIVE', 
                        waitingUntil: 0,           
                        shinkansenStartTime: null  
                      }, { merge: true }); 
                    } 
                  }} 
                  className="p-2 bg-emerald-50 text-emerald-600 rounded-xl border border-emerald-100 active:bg-emerald-100"
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
        <div className="grid grid-cols-2 gap-4">
          {(['A', 'B'] as const).map(t => (
            <div key={t} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 text-center">
              <div className="text-[10px] font-black text-slate-400 mb-1 uppercase">Team {t}</div>
              <div className="text-2xl font-black text-slate-800">{t === 'A' ? (config.teamAScore ?? 0) : (config.teamBScore ?? 0)} <span className="text-xs">pt</span></div>
              <div className="mt-3 flex gap-1">
                <input id={`score-input-${t}`} type="number" onChange={e => (t === 'A' ? setTeamAScoreInput : setTeamBScoreInput)(Number(e.target.value))} className="w-full p-2 text-xs border rounded-xl outline-none font-bold" placeholder="直接修正" />
                <button onClick={async () => { const val = t === 'A' ? teamAScoreInput : teamBScoreInput; if (val !== null) { await updateDoc(doc(db, 'game_config', 'current'), { [t === 'A' ? 'teamAScore' : 'teamBScore']: val }); } }} className="p-2 bg-indigo-600 text-white rounded-xl shadow-md"><Save size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="space-y-4">
        <button onClick={async () => { if (!confirm(`同期しますか？`)) return; setIsProcessing(true); try { const batch = writeBatch(db); const existing = await getDocs(collection(db, 'missions')); existing.docs.forEach(d => batch.delete(d.ref)); MISSIONS.forEach(m => { batch.set(doc(db, 'missions', m.id), m); }); await batch.commit(); alert('完了'); } catch { alert('失敗'); } finally { setIsProcessing(false); } }} disabled={isProcessing} className="w-full py-4 bg-blue-50 text-blue-600 rounded-2xl font-black text-xs border border-blue-100 mb-2 uppercase tracking-widest active:bg-blue-100">🔄 ミッションDB同期</button>
        <button onClick={handleResetAllData} disabled={isProcessing} className="w-full py-5 bg-red-50 text-red-600 rounded-2xl font-black text-sm border-2 border-red-100 flex items-center justify-center gap-2 uppercase tracking-widest active:bg-red-100"><AlertTriangle size={18} /> Master Reset</button>
      </div>
    </div>
  );
};

export default AdminView;