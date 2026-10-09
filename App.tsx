import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { User, PrivateLocation, ExposedLocation, GameConfig, LocationLog, GameLog, Role, Mission } from './types';
import type { UpdatePrivateLocationInput } from './src/application';
import type { SafetyAction, SafetyReasonCode } from './src/game/playerSafety';
import {
  activateInvincibility,
  capturePlayer,
  completeMission,
  exposeLocation,
  updatePrivateLocation,
  resumeWaiting,
  startWaiting,
  requestSafetyAction,
} from './src/application';
import {
  firebaseExposedLocationStore,
  firebasePrivateLocationStore,
} from './src/infrastructure/firebase/locationStores';

import {
  canRevealLocation,
  getPlayerRole,
  getRoleForTeam,
  isGamePaused,
} from './src/game';
import { INITIAL_GAME_CONFIG } from './constants';
import {
  getCurrentAuthUserId,
  signOutCurrentUser,
  subscribeAuthUserId,
} from './src/infrastructure/firebase/auth';
import { firebaseGameLogStore } from './src/infrastructure/firebase/gameplayStores';
import { firebaseCaptureGateway } from './src/infrastructure/firebase/captureActions';
import { firebaseMissionCompletionGateway } from './src/infrastructure/firebase/missionActions';
import { firebaseInvincibilityGateway } from './src/infrastructure/firebase/powerupActions';
import { firebaseWaitingGateway } from './src/infrastructure/firebase/waitingActions';
import { firebaseSafetyActionGateway } from './src/infrastructure/firebase/safetyActions';
import {
  createEmergencyLocationHeartbeatController,
  updateEmergencyLocationOnce,
} from './src/infrastructure/emergencyLocationHeartbeat';
import {
  subscribeCurrentPlayer,
  subscribeExposedLocations,
  subscribeGameConfig,
  subscribeMissions,
  subscribePlayers,
  subscribePrivateLocation,
} from './src/infrastructure/firebase/subscriptions';

// Views
import SetupView from './views/SetupView';
import MapView from './views/MapView';
import MissionView from './views/MissionView';
import AdminView from './views/AdminView';

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [privateLocation, setPrivateLocation] = useState<PrivateLocation | null>(null);
  const [exposedLocations, setExposedLocations] = useState<Record<string, ExposedLocation>>({});

  const [authUserId, setAuthUserId] = useState(getCurrentAuthUserId);
  const authUserIdRef = useRef(authUserId);
  const emergencyHeartbeat = useRef(createEmergencyLocationHeartbeatController());
  const [authReady, setAuthReady] = useState(false);
  const [userLoading, setUserLoading] = useState(true);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [gameConfig, setGameConfig] = useState<GameConfig>(INITIAL_GAME_CONFIG);
  const [locationLogs] = useState<LocationLog[]>([]);
  const [lastBroadcastTime, setLastBroadcastTime] = useState(0);
  const [safetyDialogOpen, setSafetyDialogOpen] = useState(false);
  const [safetyActionBusy, setSafetyActionBusy] = useState(false);
  const safetyActionBusyRef = useRef(false);
  const isAdminPath = window.location.hash.includes('admin-tk-2026-secret');
  const exposedPlayerIdsJson = useMemo(
    () => JSON.stringify(allUsers.filter(user => user.team === 'A' || user.team === 'B').map(user => user.id)),
    [allUsers],
  );

  useEffect(() => subscribeAuthUserId(uid => {
    authUserIdRef.current = uid;
    setAuthUserId(uid);
    setAuthReady(true);
    if (!uid) {
      setCurrentUser(null);
      setPrivateLocation(null);
      setUserLoading(false);
    } else {
      setUserLoading(true);
    }
  }), []);

  const addGameLog = useCallback(async (message: string, type: GameLog['type']): Promise<void> => {
    const newLog: GameLog = {
      id: Math.random().toString(36).substring(7),
      timestamp: Date.now(),
      message,
      type,
    };

    const currentLogs: GameLog[] = gameConfig.logs ?? [];
    try {
      await firebaseGameLogStore.append(newLog, currentLogs);
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

  // Auth UIDをキーにPlayer documentとrealtime dataを購読する
  useEffect(() => {
    if (!authUserId) return;

    const unsubscribeCurrentUser = subscribeCurrentPlayer(
      authUserId,
      player => {
        setCurrentUser(player);
        setUserLoading(false);
      },
      error => {
        console.error('Error fetching current user data:', error);
        setCurrentUser(null);
        setUserLoading(false);
      },
    );
    const unsubscribePrivateLocation = subscribePrivateLocation(
      authUserId,
      setPrivateLocation,
      error => {
        console.error('Error fetching private location:', error);
        setPrivateLocation(null);
      },
    );

    const unsubscribeUsers = subscribePlayers(
      setAllUsers,
      error => console.error('Error fetching users data:', error),
    );

    return () => {
      unsubscribeCurrentUser();
      unsubscribePrivateLocation();
      unsubscribeUsers();
    };
  }, [authUserId]);

  useEffect(() => {
    if (!authUserId) {
      setExposedLocations({});
      return;
    }
    const playerIds = JSON.parse(exposedPlayerIdsJson) as string[];
    setExposedLocations({});
    return subscribeExposedLocations(
      playerIds,
      setExposedLocations,
      error => console.error('Error fetching exposed locations:', error),
    );
  }, [authUserId, exposedPlayerIdsJson]);

  useEffect(() => {
    if (!authUserId) return;
    return subscribeMissions(
      setMissions,
      error => console.error('Error fetching missions data:', error),
    );
  }, [authUserId]);

  // GameConfig 購読 & 初期ドキュメント作成
  useEffect(() => {
    if (!authUserId) return;
    return subscribeGameConfig(
      INITIAL_GAME_CONFIG,
      config => {
        setGameConfig(config);
        if (config.broadcastTime > lastBroadcastTime && config.broadcastMessage) {
          setLastBroadcastTime(config.broadcastTime);
          alert(`【運営からの通知】\n\n${config.broadcastMessage}`);
        }
      },
      error => {
        console.error('Error fetching game config data:', error);
        alert('ゲーム設定の取得中にエラーが発生しました。通信環境をご確認ください。');
      },
      error => {
        console.error('Failed to set initial game config:', error);
        alert('初期ゲーム設定の保存に失敗しました。通信環境をご確認ください。');
      },
    );
  }, [authUserId, lastBroadcastTime]);


  const handleUpdatePrivateLocation = useCallback(
    (input: UpdatePrivateLocationInput) => updatePrivateLocation(input, firebasePrivateLocationStore),
    [],
  );

  useEffect(() => {
    emergencyHeartbeat.current.sync({
      status: currentUser?.status,
      playerId: currentUser?.id,
      authUserId,
      geolocation: 'geolocation' in navigator ? navigator.geolocation : null,
      updatePrivateLocation: handleUpdatePrivateLocation,
      isCurrentPlayer: () => Boolean(currentUser?.id) && authUserIdRef.current === currentUser?.id,
      isOnline: () => navigator.onLine,
    });
  }, [authUserId, currentUser?.id, currentUser?.status, handleUpdatePrivateLocation]);

  useEffect(() => () => emergencyHeartbeat.current.stop(), []);

  // 位置公開（スナップショット方式）
  // 押した瞬間のprivate locationをスナップショットとして5分間表示。
  // 本人がその後移動してもピンは動かない。
  const handleUpdateLocation = useCallback(async (): Promise<void> => {
    if (!currentUser || !canRevealLocation(gameConfig.gameStatus)) return;

    if (!confirm('現在地を公開しますか？\n\n公開された座標は5分間地図上に固定表示されます。\n（その後移動してもピンはその場に残ります）')) return;

    const now = Date.now();
    const EXPOSE_DURATION = 5 * 60 * 1000; // 5 分

    // MapView が随時private locationを更新しているので、それをスナップショットとして使う
    const snapLat = privateLocation?.latitude;
    const snapLng = privateLocation?.longitude;

    if (snapLat == null || snapLng == null) {
      // Private Location がまだない場合は GPS から直接取得
      if (!('geolocation' in navigator)) {
        alert('このブラウザは位置情報に対応していません。');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        async pos => {
          try {
            const privateResult = await handleUpdatePrivateLocation({
              playerId: currentUser.id,
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
            });
            if (!privateResult.ok) throw new Error(privateResult.reason);

            const exposeResult = await exposeLocation({
              playerId: currentUser.id,
              privateLocation: {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
              },
              phase: gameConfig.gameStatus,
              now,
              duration: EXPOSE_DURATION,
            }, firebaseExposedLocationStore);
            if (exposeResult.ok === false) throw new Error(exposeResult.reason);
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

    // private locationが存在する場合はそのままスナップショットとして書き込む
    try {
      const exposeResult = await exposeLocation({
        playerId: currentUser.id,
        privateLocation: { latitude: snapLat, longitude: snapLng },
        phase: gameConfig.gameStatus,
        now,
        duration: EXPOSE_DURATION,
      }, firebaseExposedLocationStore);
      if (exposeResult.ok === false) throw new Error(exposeResult.reason);
      await addGameLog(
        `Team ${currentUser.team} ${currentUser.name} が現在地を公開しました（5分間）`,
        'SYSTEM'
      );
      alert('現在地を公開しました。5分後に自動で非公開になります。');
    } catch (error) {
      console.error('Location expose error:', error);
      alert('通信エラー：位置の公開に失敗しました。');
    }
  }, [currentUser, privateLocation, gameConfig.gameStatus, handleUpdatePrivateLocation, addGameLog]);

  // Mission scoring, identity, duplicate enforcement, and logging are server-authoritative.
  const handleScoreUpdate = useCallback(
    (missionId: string) => completeMission({ missionId }, firebaseMissionCompletionGateway),
    [],
  );

  const handleSafetyAction = useCallback(async (
    action: SafetyAction,
    reasonCode: SafetyReasonCode,
  ): Promise<void> => {
    if (!currentUser || safetyActionBusyRef.current) return;
    if (action === 'RETIRE' && !confirm('リタイアしますか？この操作は管理者のみが解除できます。')) return;

    safetyActionBusyRef.current = true;
    setSafetyActionBusy(true);
    try {
      const result = await requestSafetyAction({ action, reasonCode }, firebaseSafetyActionGateway);
      setSafetyDialogOpen(false);
      if (result.ok === false) {
        alert(result.reason === 'RETIRED_TERMINAL'
          ? 'リタイア確定後はEmergencyへ変更できません。必要な場合はLINE等で管理者へ直接連絡してください。'
          : '送信に失敗しました。緊急の場合はLINE等で直接連絡してください。');
        return;
      }

      const locationUpdated = action === 'EMERGENCY'
        ? await updateEmergencyLocationOnce({
            status: 'EMERGENCY',
            playerId: currentUser.id,
            authUserId: currentUser.id,
            geolocation: 'geolocation' in navigator ? navigator.geolocation : null,
            updatePrivateLocation: handleUpdatePrivateLocation,
            isCurrentPlayer: () => authUserIdRef.current === currentUser.id,
            isOnline: () => navigator.onLine,
          })
        : false;
      const message = result.changed
        ? '送信しました。運営からの連絡を待ってください。'
        : 'このSafety Actionはすでに反映されています。';
      if (action === 'EMERGENCY') {
        const existingProjectionAvailable = result.projectionStatus === 'CREATED'
          || result.projectionStatus === 'REFRESHED';
        const locationMessage = locationUpdated
          ? '現在位置を更新しました。管理者向け地図への反映には少し時間がかかる場合があります。'
          : existingProjectionAvailable
            ? '既存の位置共有は有効ですが、現在位置を更新できませんでした。'
            : '現在位置を更新できませんでした。位置を伝える必要がある場合はLINE等で運営へ直接連絡してください。';
        alert(`${message}\n${locationMessage}`);
      } else {
        alert(message);
      }
    } finally {
      safetyActionBusyRef.current = false;
      setSafetyActionBusy(false);
    }
  }, [currentUser, handleUpdatePrivateLocation]);

  // Capture validation, state changes, reward, and logging are server-authoritative.
  const handleCapture = useCallback(async (targetId: string): Promise<void> => {
    if (!currentUser) return;

    const target = allUsers.find(user => user.id === targetId);
    if (!target || !confirm(`${target.name} を捕獲しましたか？`)) return;

    const result = await capturePlayer({ targetId }, firebaseCaptureGateway);
    if (result.ok === false) {
      alert(result.reason === 'CAPTURE_REJECTED'
        ? 'このプレイヤーは捕獲できません。'
        : '捕獲処理に失敗しました。');
    }
  }, [currentUser, allUsers]);

  // 無敵カード使用
  const handleActivateInvincibility = useCallback(async (): Promise<void> => {
    if (!currentUser || !confirm('無敵カードを使いますか？（30分間有効）')) return;

    const result = await activateInvincibility({}, firebaseInvincibilityGateway);
    if (result.ok === false) {
      alert(result.reason === 'NO_CARDS'
        ? '無敵カードがありません。'
        : '現在の状態では無敵カードを使用できません。');
      return;
    }

    alert('無敵モード発動！');
  }, [currentUser]);

  // Waiting eligibility, deadline, persistence, and logging are server-authoritative.
  const handleStartShinkansenWait = useCallback(async (): Promise<void> => {
    if (!currentUser || !confirm('新幹線移動（1時間待機）を開始しますか？')) return;

    const result = await startWaiting({}, firebaseWaitingGateway);
    if (!result.ok) {
      alert('現在の状態では待機を開始できません。');
      return;
    }
    alert('待機モードに入りました。お疲れ様でした。');
  }, [currentUser]);

  const handleResumeWaiting = useCallback(async (): Promise<void> => {
    const result = await resumeWaiting({}, firebaseWaitingGateway);
    if (result.ok === false) console.error('Waiting resume request was rejected:', result.reason);
  }, []);

  // ---- 画面分岐 ----

  if (!authReady || userLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">
        <div className="text-sm font-bold">Loading...</div>
      </div>
    );
  }

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
          onClick={() => setSafetyDialogOpen(true)}
          className="mt-4 rounded-2xl bg-red-600 px-6 py-4 font-black text-white shadow-lg"
        >
          SOS / リタイア
        </button>
        {safetyDialogOpen && (
          <SafetyActionDialog
            busy={safetyActionBusy}
            onClose={() => setSafetyDialogOpen(false)}
            onChoose={handleSafetyAction}
          />
        )}

        <button
          onClick={async () => { await signOutCurrentUser(); window.location.reload(); }}
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
            <button
              onClick={() => setSafetyDialogOpen(true)}
              className="pointer-events-auto mt-6 rounded-2xl bg-white px-6 py-4 font-black text-red-700 shadow-lg"
            >
              SOS / リタイア
            </button>
          </div>
        )}
        {safetyDialogOpen && (
          <SafetyActionDialog
            busy={safetyActionBusy}
            onClose={() => setSafetyDialogOpen(false)}
            onChoose={handleSafetyAction}
          />
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
              onClick={() => setSafetyDialogOpen(true)}
              aria-label="SOS / リタイア"
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
                    privateLocation={privateLocation}
                    exposedLocations={exposedLocations}
                    gameConfig={gameConfig}
                    onUpdatePrivateLocation={handleUpdatePrivateLocation}
                    onCapture={handleCapture}
                    onActivateInvincibility={handleActivateInvincibility}
                    onStartShinkansenWait={handleStartShinkansenWait}
                    onResumeWaiting={handleResumeWaiting}
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

const SafetyActionDialog: React.FC<{
  busy: boolean;
  onClose: () => void;
  onChoose: (action: SafetyAction, reasonCode: SafetyReasonCode) => Promise<void>;
}> = ({ busy, onClose, onChoose }) => (
  <div className="fixed inset-0 z-3000 flex items-center justify-center bg-slate-950/80 p-5" role="dialog" aria-modal="true" aria-label="Safety Action">
    <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-black text-slate-900">緊急連絡 / リタイア</h2>
        <button onClick={onClose} disabled={busy} aria-label="閉じる" className="rounded-lg p-2 text-slate-500 disabled:opacity-50">
          <XCircle size={22} />
        </button>
      </div>
      <p className="mb-4 text-sm font-medium text-slate-600">該当する内容を選択してください。詳細な個人情報は記録されません。Emergencyを選ぶと、最新の位置情報がある場合に限り、正確な位置を管理者だけに最大2分間共有します。リタイアでは位置を共有しません。</p>
      <div className="grid gap-2">
        <button disabled={busy} onClick={() => void onChoose('EMERGENCY', 'ILLNESS_OR_INJURY')} className="rounded-xl bg-red-50 px-4 py-3 text-left font-bold text-red-800 disabled:opacity-50">急病・怪我</button>
        <button disabled={busy} onClick={() => void onChoose('EMERGENCY', 'EQUIPMENT_ISSUE')} className="rounded-xl bg-red-50 px-4 py-3 text-left font-bold text-red-800 disabled:opacity-50">機材トラブル</button>
        <button disabled={busy} onClick={() => void onChoose('EMERGENCY', 'OTHER')} className="rounded-xl bg-red-50 px-4 py-3 text-left font-bold text-red-800 disabled:opacity-50">その他の緊急事態</button>
        <button disabled={busy} onClick={() => void onChoose('RETIRE', 'RETIREMENT_REQUEST')} className="mt-2 rounded-xl bg-slate-900 px-4 py-3 text-left font-bold text-white disabled:opacity-50">リタイア</button>
      </div>
      {busy && <p className="mt-4 text-center text-sm font-bold text-slate-500">送信中...</p>}
      <p className="mt-4 text-xs text-slate-500">送信できない場合はLINE等で運営へ直接連絡してください。</p>
    </div>
  </div>
);

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