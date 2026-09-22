import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { HashRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import {
  Map as MapIcon,
  Target,
  Settings,
  RefreshCw,
  AlertCircle,
  Trophy,
  Navigation,
  Shield,
  Zap,
  Swords,
  History,
  Medal,
  LogOut,
  AlertTriangle,
  Phone,
  XCircle,
  Clock
} from 'lucide-react';
import { User, GameConfig, LocationLog, GameLog, Role, Mission } from './types';
import {
  calculateMissionReward,
  activateInvincibility,
  calculateMissionScore,
  canRevealLocation,
  canScore,
  getPlayerRole,
  getRoleForTeam,
  isGamePaused,
  SHINKANSEN_LIMIT_DURATION_MS,
  SHINKANSEN_WAIT_DURATION_MS,
} from './src/game';
import { INITIAL_GAME_CONFIG } from './constants';
import { auth, db } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, updateDoc, onSnapshot, collection, setDoc, serverTimestamp, increment} from 'firebase/firestore';

// Views
import SetupView from './views/SetupView';
import MapView from './views/MapView';
import MissionView from './views/MissionView';
import AdminView from './views/AdminView';

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('kyun_user');
    if (saved) {
      try {
        return JSON.parse(saved) as User;
      } catch (e) {
        console.error('Failed to parse saved user', e);
        return null;
      }
    }
    return null;
  });

  const [authUser, setAuthUser] = useState(auth.currentUser);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [gameConfig, setGameConfig] = useState<GameConfig>(INITIAL_GAME_CONFIG);
  const [locationLogs] = useState<LocationLog[]>([]);
  const [lastBroadcastTime, setLastBroadcastTime] = useState(0);
  const isAdminPath = window.location.hash.includes('admin-tk-2026-secret');

  useEffect(() => onAuthStateChanged(auth, setAuthUser), []);

  const addGameLog = useCallback(async (message: string, type: GameLog['type']): Promise<void> => {
    const newLog: GameLog = {
      id: Math.random().toString(36).substring(7),
      timestamp: Date.now(),
      message,
      type,
    };
    const configRef = doc(db, 'game_config', 'current');
    const currentLogs: GameLog[] = gameConfig.logs ?? [];
    const updatedLogs = [newLog, ...currentLogs].slice(0, 200);
    try {
      await updateDoc(configRef, { logs: updatedLogs });
    } catch (error) {
      console.error('Failed to add game log:', error);
    }
  }, [gameConfig.logs]);

  // この値は既存UIの表示用。Firestore権限はAuthenticationとRulesで強制する。
  const isAdmin = useMemo(
    () => currentUser?.team === 'ADMIN',
    [currentUser]
  );

  const myRole = useMemo((): Role => {
    if (!currentUser) return 'RUNNER';
    if (isAdmin) return 'ONI';
    return getPlayerRole(currentUser, gameConfig);
  }, [currentUser, gameConfig.teamARole, gameConfig.teamBRole, isAdmin]);

  // Users 購読
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(
      collection(db, 'users'),
      snapshot => {
        const users = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as User));
        setAllUsers(users);

        const saved = localStorage.getItem('kyun_user');
        if (!saved) return;

        let localUser: User;
        try {
          localUser = JSON.parse(saved) as User;
        } catch {
          return;
        }

        const remoteUser = users.find(u => u.id === localUser.id);
        if (remoteUser) {
          setCurrentUser(remoteUser);
          localStorage.setItem('kyun_user', JSON.stringify(remoteUser));
        } else {
          localStorage.removeItem('kyun_user');
          setCurrentUser(null);
          if (localUser.team !== 'ADMIN') {
            alert('アカウントが削除されました。最初からやり直してください。');
          }
        }
      },
      error => {
        console.error('Error fetching users data:', error);
      }
    );
    return () => unsub();
  }, [authUser?.uid]);

  // Missions 購読
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(
      collection(db, 'missions'),
      snapshot => {
        // Firestore ドキュメントIDを id フィールドとして確実にマージ
        const missionData = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Mission));
        setMissions(missionData);
      },
      error => {
        console.error('Error fetching missions data:', error);
      }
    );
    return () => unsub();
  }, [authUser?.uid]);

  // GameConfig 購読 & 自動更新処理
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(
      doc(db, 'game_config', 'current'),
      async snapshot => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          const config: GameConfig = { ...INITIAL_GAME_CONFIG, ...data, logs: data.logs ?? [] };
          setGameConfig(config);

          // ブロードキャスト通知
          if (config.broadcastTime > lastBroadcastTime && config.broadcastMessage) {
            setLastBroadcastTime(config.broadcastTime);
            alert(`【運営からの通知】\n\n${config.broadcastMessage}`);
          }

          
        } else {
          try {
            await setDoc(doc(db, 'game_config', 'current'), INITIAL_GAME_CONFIG);
          } catch (error) {
            console.error('Failed to set initial game config:', error);
            alert('初期ゲーム設定の保存に失敗しました。通信環境をご確認ください。');
          }
        }
      },
      error => {
        console.error('Error fetching game config data:', error);
        alert('ゲーム設定の取得中にエラーが発生しました。通信環境をご確認ください。');
      }
    );
    return () => unsub();
  }, [authUser?.uid, lastBroadcastTime]);

  // 新幹線移動時間超過時の自動待機モード移行
  useEffect(() => {
    if (isGamePaused(gameConfig.gameStatus)) return;

    const now = Date.now();
    const TWO_POINT_FIVE_HOURS = SHINKANSEN_LIMIT_DURATION_MS;

    allUsers.forEach(user => {
      if (!user.shinkansenStartTime || user.status !== 'ACTIVE') return;
      if (now - user.shinkansenStartTime <= TWO_POINT_FIVE_HOURS) return;

      (async () => {
        try {
          await updateDoc(doc(db, 'users', user.id), {
            status: 'WAITING',
            waitingUntil: now + SHINKANSEN_WAIT_DURATION_MS,
            shinkansenStartTime: null,
          });
          await addGameLog(
            `Team ${user.team} ${user.name} が新幹線移動時間超過のため自動で待機モードに移行しました。`,
            'SYSTEM'
          );
          if (user.id === currentUser?.id) {
            alert('新幹線移動時間（2.5時間）を超過したため、自動的に待機モードに移行しました。1時間後に解除されます。');
          }
        } catch (error) {
          console.error('Failed to auto-transition user to waiting status:', error);
        }
      })();
    });
  }, [allUsers, gameConfig.gameStatus, currentUser?.id, addGameLog]);

  // 位置公開（スナップショット方式）
  // 押した瞬間の lastLat/lastLng を exposedLat/Lng に保存し 5 分間表示。
  // 本人がその後移動してもピンは動かない。
  const handleUpdateLocation = useCallback(async (): Promise<void> => {
    if (!currentUser || !canRevealLocation(gameConfig.gameStatus)) return;

    if (!confirm('現在地を公開しますか？\n\n公開された座標は5分間地図上に固定表示されます。\n（その後移動してもピンはその場に残ります）')) return;

    const now = Date.now();
    const EXPOSE_DURATION = 5 * 60 * 1000; // 5 分

    // MapView が随時 lastLat/lastLng を更新しているので、それをスナップショットとして使う
    const snapLat = currentUser.lastLat;
    const snapLng = currentUser.lastLng;

    if (!snapLat || !snapLng || (snapLat === 0 && snapLng === 0)) {
      // lastLat/lastLng がまだない場合は GPS から直接取得
      if (!('geolocation' in navigator)) {
        alert('このブラウザは位置情報に対応していません。');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        async pos => {
          try {
            await updateDoc(doc(db, 'users', currentUser.id), {
              lastLat: pos.coords.latitude,
              lastLng: pos.coords.longitude,
              lastUpdate: serverTimestamp(),
              exposedLat: pos.coords.latitude,
              exposedLng: pos.coords.longitude,
              locationExposedUntil: now + EXPOSE_DURATION,
            });
            await addGameLog(
              `Team ${currentUser.team} ${currentUser.name} が現在地を公開しました（5分間）`,
              'SYSTEM'
            );
            alert('現在地を公開しました。5分後に自動で非公開になります。');
          } catch (error) {
            console.error('Location expose error:', error);
            alert('通信エラー：位置の公開に失敗しました。');
          }
        },
        error => {
          const msg = error.code === 3
            ? 'GPSの取得がタイムアウトしました。場所を変えてお試しください。'
            : '位置情報を取得できませんでした。';
          alert(msg);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
      return;
    }

    // lastLat/lastLng が存在する場合はそのままスナップショットとして書き込む
    try {
      await updateDoc(doc(db, 'users', currentUser.id), {
        exposedLat: snapLat,
        exposedLng: snapLng,
        locationExposedUntil: now + EXPOSE_DURATION,
      });
      await addGameLog(
        `Team ${currentUser.team} ${currentUser.name} が現在地を公開しました（5分間）`,
        'SYSTEM'
      );
      alert('現在地を公開しました。5分後に自動で非公開になります。');
    } catch (error) {
      console.error('Location expose error:', error);
      alert('通信エラー：位置の公開に失敗しました。');
    }
  }, [currentUser, gameConfig.gameStatus, isAdmin, addGameLog]);

  // スコア更新（ミッション完了時）
  const handleScoreUpdate = useCallback(async (mission: Mission, isFinalMission: boolean): Promise<void> => {
    if (!currentUser || !canScore(gameConfig.gameStatus)) return;

    try {
      const reward = calculateMissionReward(mission, isFinalMission);
      const score = calculateMissionScore(reward, Math.random());
      const teamField = currentUser.team === 'A' ? 'teamAScore' : 'teamBScore';
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // increment を使うことで複数端末の同時操作による先祖返りを防止
      await updateDoc(doc(db, 'game_config', 'current'), {
        [teamField]: increment(score.teamScoreDelta),
      });

      const updates: Partial<User> & Record<string, unknown> = {
        score: increment(score.playerScoreDelta) as unknown as number,
      };
      const buffMessage = score.luckyReward ? '【LUCKY】無敵カード獲得！' : '';
      if (score.invincibleCardDelta > 0) {
        updates.invincibleCards = (currentUser.invincibleCards ?? 0) + score.invincibleCardDelta;
      }
      await updateDoc(doc(db, 'users', currentUser.id), updates);
      await addGameLog(
        `${timeStr} Team ${currentUser.team} ${currentUser.name} がミッション達成 (+${score.playerScoreDelta}pt) ${buffMessage}`.trim(),
        'MISSION'
      );

      // alert はMissionView側で表示するためここでは出さない
    } catch (error) {
      console.error('Score update error:', error);
      alert('通信エラー：圏外か不安定な環境です。電波の良い場所で再度ボタンを押してください。');
    }
  }, [currentUser, gameConfig.gameStatus, isAdmin, gameConfig.teamAScore, gameConfig.teamBScore, addGameLog]);

  // SOS
  const handleSOS = async (): Promise<void> => {
    const reason = prompt(
      '緊急連絡の内容を選択してください：\n1: 急病・怪我\n2: 機材トラブル\n3: リタイア希望\n(番号または内容を入力)'
    );
    if (!reason || !currentUser) return;

    const status: User['status'] =
      reason === '3' || reason.includes('リタイア') ? 'RETIRED' : 'EMERGENCY';

    try {
      await updateDoc(doc(db, 'users', currentUser.id), { status });
      await addGameLog(
        `【緊急】Team ${currentUser.team} ${currentUser.name} が SOS を発信: ${reason}`,
        'EMERGENCY'
      );
      alert('SOSを送信しました。運営からの連絡を待ってください。');
    } catch {
      alert('送信に失敗しました。LINE等で直接連絡してください。');
    }
  };

  // 捕獲処理
  const handleCapture = useCallback(async (_dummy: string): Promise<void> => {
    if (!currentUser || myRole !== 'ONI' || (isGamePaused(gameConfig.gameStatus) && !isAdmin)) return;

    const now = Date.now();
    const target = allUsers.find(u => {
      const uRole: Role = getPlayerRole(u, gameConfig);
      return (
        uRole === 'RUNNER' &&
        u.status === 'ACTIVE' &&
        !(u.invincibleUntil && u.invincibleUntil > now)
      );
    });

    if (!target) {
      alert('周囲に有効な逃走者がいません。');
      return;
    }
    if (!confirm(`${target.name} を捕獲しましたか？`)) return;

    const thirtyMinutes = 30 * 60 * 1000;
    const newRoleA: Role = gameConfig.teamARole === 'ONI' ? 'RUNNER' : 'ONI';
    const newRoleB: Role = newRoleA === 'ONI' ? 'RUNNER' : 'ONI';

    try {
      await updateDoc(doc(db, 'game_config', 'current'), {
        teamARole: newRoleA,
        teamBRole: newRoleB,
        nextRevealTime: now + thirtyMinutes,
        // increment で先祖返り防止（捕獲成功チームにのみ50pt加算）
        ...(currentUser.team === 'A' ? { teamAScore: increment(50) } : { teamBScore: increment(50) }),
        
      });

      const oniTeam = newRoleA === 'ONI' ? 'A' : 'B';
      const batch: Promise<void>[] = allUsers.map(u => {
        if (u.team === oniTeam) {
          // setDoc merge: ドキュメント未存在でもエラーにならない
          return setDoc(doc(db, 'users', u.id), {
            status: 'WAITING',
            waitingUntil: now + thirtyMinutes,
            invincibleUntil: 0,
          }, { merge: true });
        } else {
          return setDoc(doc(db, 'users', u.id), {
            status: 'ACTIVE',
            waitingUntil: 0,
            invincibleCards: (u.invincibleCards ?? 0) + 1,
          }, { merge: true });
        }
      });
      await Promise.all(batch);

      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      await addGameLog(`${timeStr} Team ${currentUser.team} が捕獲成功！攻守交代 (+50pt)`, 'CAPTURE');
    } catch (error) {
      console.error('Capture error:', error);
      alert('捕獲処理に失敗しました。');
    }
  }, [currentUser, allUsers, gameConfig, myRole, isAdmin, addGameLog]);

  // 無敵カード使用
  const handleActivateInvincibility = useCallback(async (): Promise<void> => {
    if (!currentUser) return;

    const now = Date.now();
    const activation = activateInvincibility({
      role: myRole,
      invincibleCards: currentUser.invincibleCards ?? 0,
      invincibleUntil: currentUser.invincibleUntil,
      phase: gameConfig.gameStatus,
      now,
    });
    if (!activation.allowed) return;
    if (!confirm('無敵カードを使いますか？（30分間有効）')) return;

    try {
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      await updateDoc(doc(db, 'users', currentUser.id), {
        invincibleUntil: activation.invincibleUntil,
        invincibleCards: (currentUser.invincibleCards ?? 0) + activation.cardDelta,
      });
      await addGameLog(
        `${timeStr} Team ${currentUser.team} ${currentUser.name} が無敵カードを使用`,
        'SYSTEM'
      );
      alert('無敵モード発動！');
    } catch (error) {
      console.error('Invincibility error:', error);
      alert('無敵カードの使用に失敗しました。');
    }
  }, [currentUser, myRole, gameConfig.gameStatus, addGameLog]);

  // 新幹線待機
  const handleStartShinkansenWait = useCallback(async (): Promise<void> => {
    if (!currentUser || (isGamePaused(gameConfig.gameStatus) && !isAdmin)) return;

    if (!confirm('新幹線移動（1時間待機）を開始しますか？')) return;

    try {
      const now = Date.now();
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      await updateDoc(doc(db, 'users', currentUser.id), {
        status: 'WAITING',
        waitingUntil: now + SHINKANSEN_WAIT_DURATION_MS,
        shinkansenStartTime: now,
      });
      await addGameLog(
        `${timeStr} Team ${currentUser.team} ${currentUser.name} が新幹線待機を開始 (60分)`,
        'SYSTEM'
      );
      alert('待機モードに入りました。お疲れ様でした。');
    } catch (error) {
      console.error('Shinkansen wait error:', error);
      alert('通信エラー：新幹線モードへの切り替えに失敗しました。トンネルを抜けてから再度お試しください。');
    }
  }, [currentUser, gameConfig.gameStatus, isAdmin, addGameLog]);

  // ---- 画面分岐 ----

  if (!currentUser && !isAdminPath) return <SetupView onComplete={setCurrentUser} />;

  // ゲームオーバー画面
  if ((gameConfig.gameStatus === 'GAME_OVER' || gameConfig.isGameOver) && !isAdminPath) {
    const aScore = gameConfig.teamAScore ?? 0;
    const bScore = gameConfig.teamBScore ?? 0;
    const winner = getRoleForTeam('A', gameConfig) === 'RUNNER' ? 'A' : getRoleForTeam('B', gameConfig) === 'RUNNER' ? 'B' : 'DRAW';
    return (
      <div className="min-h-screen bg-slate-900 text-white p-6 flex flex-col items-center overflow-y-auto">
        <Trophy size={80} className="text-amber-500 mb-6 animate-bounce" />
        <h1 className="text-4xl font-black italic mb-2">FINAL RESULT</h1>
        <p className="text-slate-400 font-bold mb-12 uppercase tracking-widest">全行程終了！お疲れ様でした</p>

        <div className="w-full max-w-md bg-slate-800 rounded-3xl p-8 border-2 border-slate-700 shadow-2xl mb-8">
          <div className="text-center mb-8">
            <div className="text-xs font-black text-slate-500 uppercase mb-2">Winner</div>
            <div className={`text-6xl font-black ${winner === 'A' ? 'text-red-500' : winner === 'B' ? 'text-blue-500' : 'text-white'}`}>
              {winner === 'DRAW' ? 'DRAW' : `TEAM ${winner}`}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center p-4 bg-red-500/10 rounded-2xl border border-red-500/20">
              <div className="text-[10px] font-black text-red-500 uppercase mb-1">Team A</div>
              <div className="text-3xl font-black">{aScore} <span className="text-xs">pt</span></div>
            </div>
            <div className="text-center p-4 bg-blue-500/10 rounded-2xl border border-blue-500/20">
              <div className="text-[10px] font-black text-blue-500 uppercase mb-1">Team B</div>
              <div className="text-3xl font-black">{bScore} <span className="text-xs">pt</span></div>
            </div>
          </div>
        </div>

        <div className="w-full max-w-md bg-slate-800/50 rounded-3xl p-6 border border-slate-700">
          <h3 className="flex items-center gap-2 font-black text-slate-400 mb-4 uppercase tracking-widest text-sm">
            <History size={18} /> Game History
          </h3>
          <div className="space-y-3">
            {(gameConfig.logs ?? []).map(log => (
              <div key={log.id} className="text-xs border-b border-slate-700/50 pb-2 flex gap-3">
                <span className="text-slate-500 shrink-0 font-mono">
                  {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className={
                  log.type === 'CAPTURE' ? 'text-red-400 font-bold' :
                  log.type === 'MISSION' ? 'text-indigo-400 font-bold' :
                  log.type === 'EMERGENCY' ? 'text-amber-400 font-black' :
                  'text-slate-300'
                }>
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={() => { localStorage.removeItem('kyun_user'); window.location.reload(); }}
          className="mt-12 flex items-center gap-2 text-slate-500 font-bold hover:text-white transition-colors"
        >
          <LogOut size={18} /> 最初に戻る
        </button>
      </div>
    );
  }

  const gamePaused = isGamePaused(gameConfig.gameStatus);

  return (
    <HashRouter>
      <div className="flex flex-col h-screen max-h-screen bg-slate-50 overflow-hidden">
        {/* 一時中断オーバーレイ */}
        {gamePaused && !isAdmin && (
          <div className="absolute inset-0 z-[2000] bg-red-600/95 backdrop-blur-md flex flex-col items-center justify-center p-8 text-center text-white">
            <AlertTriangle size={80} className="mb-6 animate-bounce" />
            <h2 className="text-3xl font-black mb-4 uppercase italic">ゲーム一時中断</h2>
            <p className="text-lg font-bold leading-relaxed mb-8">
              現在、ゲームは一時中断しています。<br />再開までしばらくお待ちください。
            </p>
            <div className="bg-white/20 p-4 rounded-2xl text-sm font-bold">
              スコア加算、タイマー、無敵時間等は<br />すべて停止しています。
            </div>
          </div>
        )}

        {/* 役割バナー */}
        <div className={`px-4 py-1 flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest text-white ${getRoleForTeam('A', gameConfig) === 'ONI' ? 'bg-red-600' : 'bg-blue-600'}`}>
          <Swords size={12} />
          {getRoleForTeam('A', gameConfig) === 'ONI'
            ? 'Team A is ONI / Team B is RUNNER'
            : 'Team B is ONI / Team A is RUNNER'}
        </div>

        {/* ヘッダー */}
        <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm z-10">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-lg transition-all ${myRole === 'ONI' ? 'bg-slate-900 ring-4 ring-slate-100' : 'bg-blue-600 ring-4 ring-blue-50'}`}>
              {myRole === 'ONI' ? <Shield size={22} /> : <Zap size={22} />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter ${myRole === 'ONI' ? 'bg-slate-900 text-white' : 'bg-blue-600 text-white'}`}>
                  {myRole}
                </span>
                <h1 className="font-bold text-slate-800 text-sm leading-tight">Team {currentUser.team}</h1>
              </div>
              <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                {gameConfig.currentRegion ?? ''} AREA
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={handleSOS}
              className="w-10 h-10 bg-red-50 text-red-600 rounded-xl flex items-center justify-center border border-red-100 active:scale-90 transition-all shadow-sm"
            >
              <Phone size={20} />
            </button>
            <div className="flex items-center gap-3 bg-slate-50 px-3 py-2 rounded-2xl border border-slate-100">
              <div className="text-center">
                <div className="text-[8px] font-black text-red-500 uppercase">A</div>
                <div className="text-xs font-black text-slate-800">{gameConfig.teamAScore ?? 0}</div>
              </div>
              <div className="w-px h-4 bg-slate-200" />
              <div className="text-center">
                <div className="text-[8px] font-black text-blue-500 uppercase">B</div>
                <div className="text-xs font-black text-slate-800">{gameConfig.teamBScore ?? 0}</div>
              </div>
            </div>
          </div>
        </header>

        {/* メインコンテンツ */}
        <main className="flex-1 overflow-y-auto relative pb-20">
          {(gameConfig.gameStatus === 'PRE_GAME' || gameConfig.gameStatus === 'DAY1_ENDED') &&
          !isAdmin &&
          !isAdminPath ? (
            gameConfig.gameStatus === 'PRE_GAME' ? (
              <div className="absolute inset-0 z-50 bg-white flex flex-col items-center justify-center p-6 text-center">
                <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-6 animate-pulse">
                  <Clock size={40} className="text-slate-400" />
                </div>
                <h2 className="text-2xl font-black text-slate-900 mb-2 italic">WAITING...</h2>
                <p className="text-slate-500 font-medium">
                  管理者の開始合図を待っています。<br />開始までしばらくお待ちください。
                </p>
              </div>
            ) : (
              <div className="absolute inset-0 z-50 bg-slate-900 flex flex-col items-center justify-center p-8 text-center text-white">
                <XCircle size={64} className="text-slate-500 mb-6" />
                <h2 className="text-2xl font-black mb-2 italic uppercase">DAY 1 FINISHED</h2>
                <p className="text-slate-400 font-bold mb-8 uppercase tracking-widest text-xs leading-relaxed">
                  本日の行程はすべて終了しました。<br />各自、宿へ向かってください。
                </p>
                <div className="bg-slate-800 p-6 rounded-3xl border border-slate-700">

                    <div className="text-xs text-slate-500 font-black mb-2 uppercase text-center">Team {currentUser.team} Total Score</div>
                    <div className="text-5xl font-black text-center mt-2">
                      {/* 自分のチームに合わせて gameConfig から数値を取得する */}
                      {currentUser.team === 'A' ? (gameConfig.teamAScore ?? 0) : (gameConfig.teamBScore ?? 0)}
                      <span className="text-lg ml-1 text-slate-400 font-bold">pt</span>
                    </div>
                    
                    {/* もし個人の貢献度（個人のスコア）も小さく出したい場合は以下を追加（任意） */}
                    <div className="mt-4 pt-4 border-t border-slate-700/50 text-center">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Your Individual Contribution: {currentUser.score ?? 0}pt</span>
                    </div>
                  </div>
                </div>
            )
          ) : (
            <Routes>
              <Route
                path="/map"
                element={
                  <MapView
                    users={allUsers}
                    logs={locationLogs}
                    currentUser={currentUser}
                    gameConfig={gameConfig}
                    onCapture={handleCapture}
                    onActivateInvincibility={handleActivateInvincibility}
                    onStartShinkansenWait={handleStartShinkansenWait}
                  />
                }
              />
              <Route
                path="/mission"
                element={
                  <MissionView
                    config={gameConfig}
                    onComplete={handleScoreUpdate}
                    onExposeLocation={handleUpdateLocation}
                    user={currentUser}
                    missions={missions}
                  />
                }
              />
              <Route
                path="/admin-tk-2026-secret"
                element={
                  <AdminView
                    config={gameConfig}
                    setConfig={async () => {}}
                    users={allUsers}
                    missions={missions}
                  />
                }
              />
              <Route path="*" element={<Navigate to="/map" replace />} />
            </Routes>
          )}

          {isAdmin && (
            <Link
              to="/admin-tk-2026-secret"
              className="fixed right-6 bottom-24 w-14 h-14 bg-slate-900 text-white rounded-full flex items-center justify-center shadow-2xl z-[1000] border-4 border-white active:scale-90 transition-transform"
            >
              <Settings size={24} />
            </Link>
          )}
        </main>

        {/* ボトムナビ */}
        <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex justify-around items-center h-16 px-2 z-10 shadow-[0_-4px_10px_rgba(0,0,0,0.03)]">
          <NavAnchor to="/map" icon={<MapIcon size={24} />} label="MAP" />
          <NavAnchor to="/mission" icon={<Target size={24} />} label="MISSION" />
        </nav>
      </div>
    </HashRouter>
  );
};

const NavAnchor: React.FC<{ to: string; icon: React.ReactNode; label: string }> = ({
  to,
  icon,
  label,
}) => {
  const location = useLocation();
  const isActive = location.pathname === to;
  return (
    <Link
      to={to}
      className={`flex flex-col items-center justify-center gap-0.5 px-6 h-full transition-colors relative ${isActive ? 'text-blue-600' : 'text-slate-400'}`}
    >
      <div className={`${isActive ? 'scale-110' : ''} transition-transform`}>{icon}</div>
      <span className="text-[10px] font-black uppercase tracking-tighter">{label}</span>
      {isActive && (
        <div className="absolute top-0 w-8 h-1 bg-blue-600 rounded-b-full shadow-[0_2px_10px_rgba(37,99,235,0.4)]" />
      )}
    </Link>
  );
};

export default App;