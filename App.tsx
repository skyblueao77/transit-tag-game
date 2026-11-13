import type React from 'react';
import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import {
  Map as MapIcon,
  Target,
  Settings,
  Shield,
  Zap,
  Swords,
  AlertTriangle,
  Phone,
  XCircle,
  Clock,
  WifiOff,
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import type { LocationLog, Role, ProtectionZoneType } from './types';
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
  firebaseEmergencyLocationStore,
  firebaseExposedLocationStore,
  firebasePrivateLocationStore,
} from './src/infrastructure/firebase/locationStores';

import { DEFAULT_DYNAMIC_RULE_SETTINGS } from './constants';
import {
  canRevealLocation,
  determineGameWinner,
  getPlayerRole,
  getRoleForTeam,
  INVINCIBILITY_DURATION_MS,
  isGamePaused,
} from './src/game';

import {
  signOutCurrentUser,
} from './src/infrastructure/firebase/auth';
import {
  updatePlayerLastStation,
  updatePlayerProtectionZone,
  startPlayerShinkansen,
  incrementPlayerShinkansenSegment,
  resetPlayerShinkansen,
} from './src/infrastructure/firebase/playerStore';

import { firebaseCaptureGateway } from './src/infrastructure/firebase/captureActions';
import { firebaseMissionCompletionGateway } from './src/infrastructure/firebase/missionActions';
import { firebaseInvincibilityGateway } from './src/infrastructure/firebase/powerupActions';
import { firebaseWaitingGateway } from './src/infrastructure/firebase/waitingActions';
import { firebaseSafetyActionGateway } from './src/infrastructure/firebase/safetyActions';
import {
  createEmergencyLocationHeartbeatController,
  updateEmergencyLocationOnce,
} from './src/infrastructure/emergencyLocationHeartbeat';

import useAuthUser from './src/hooks/useAuthUser';
import useGameSubscriptions from './src/hooks/useGameSubscriptions';
import useConfirmDialog from './src/hooks/useConfirmDialog';
import useOnlineStatus from './src/hooks/useOnlineStatus';
import usePlayerAutoExpose from './src/hooks/usePlayerAutoExpose';
import useWaitingAutoResume from './src/hooks/useWaitingAutoResume';
import ConfirmDialog from './src/components/ui/ConfirmDialog';
import LoadingSpinner from './src/components/ui/LoadingSpinner';
import FinalResultView from './src/components/game/FinalResultView';
import SafetyActionDialog from './src/components/game/SafetyActionDialog';

// Route-based Code Splitting with React.lazy
const SetupView = lazy(() => import('./views/SetupView'));
const MapView = lazy(() => import('./views/MapView'));
const MissionView = lazy(() => import('./views/MissionView'));
const AdminView = lazy(() => import('./views/AdminView'));

const App: React.FC = () => {
  const { authUserId, authReady, currentUser, userLoading, setCurrentUser } = useAuthUser();
  const authUserIdRef = useRef(authUserId);
  useEffect(() => {
    authUserIdRef.current = authUserId;
  }, [authUserId]);

  const emergencyHeartbeat = useRef(createEmergencyLocationHeartbeatController());

  const onBroadcast = useCallback((message: string) => {
    toast.info(`【運営からの通知】\n\n${message}`, { duration: 10000 });
  }, []);

  const onConfigError = useCallback((error: Error) => {
    console.error('Error fetching game config data:', error);
    toast.error('ゲーム設定の取得中にエラーが発生しました。通信環境をご確認ください。');
  }, []);

  const {
    allUsers,
    missions,
    gameConfig,
    privateLocation,
    exposedLocations,
  } = useGameSubscriptions(authUserId, onBroadcast, onConfigError);

  const { confirm, dialogProps } = useConfirmDialog();
  const isOnline = useOnlineStatus();

  const [locationLogs] = useState<LocationLog[]>([]);
  const [safetyDialogOpen, setSafetyDialogOpen] = useState(false);
  const [safetyActionBusy, setSafetyActionBusy] = useState(false);
  const safetyActionBusyRef = useRef(false);
  const [isAdminPath, setIsAdminPath] = useState<boolean>(() =>
    typeof window !== 'undefined' && (
      window.location.pathname === '/admin' ||
      window.location.hash.includes('/admin')
    ),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncPath = () => {
      setIsAdminPath(
        window.location.pathname === '/admin' ||
        window.location.hash.includes('/admin'),
      );
    };
    window.addEventListener('hashchange', syncPath);
    window.addEventListener('popstate', syncPath);
    return () => {
      window.removeEventListener('hashchange', syncPath);
      window.removeEventListener('popstate', syncPath);
    };
  }, []);

  // この値は既存UIの表示用。Firestore権限はAuthenticationとRulesで強制する。
  const isAdmin = useMemo(
    () => currentUser?.team === 'ADMIN',
    [currentUser]
  );

  const myRole = useMemo((): Role => {
    if (!currentUser) return 'RUNNER';
    if (isAdmin) return 'ONI';
    return getPlayerRole(currentUser, gameConfig);
  }, [currentUser, gameConfig, isAdmin]);


  const handleUpdatePrivateLocation = useCallback(
    (input: UpdatePrivateLocationInput) => updatePrivateLocation(input, firebasePrivateLocationStore),
    [],
  );

  const handleUpdateEmergencyLocation = useCallback(
    (input: UpdatePrivateLocationInput) => updatePrivateLocation(input, firebaseEmergencyLocationStore),
    [],
  );

  useEffect(() => {
    emergencyHeartbeat.current.sync({
      status: currentUser?.status,
      playerId: currentUser?.id,
      expectedSessionId: gameConfig.gameSessionId,
      authUserId,
      geolocation: 'geolocation' in navigator ? navigator.geolocation : null,
      updatePrivateLocation: handleUpdateEmergencyLocation,
      isCurrentPlayer: () => Boolean(currentUser?.id) && authUserIdRef.current === currentUser?.id,
      isOnline: () => navigator.onLine,
    });
  }, [authUserId, currentUser?.id, currentUser?.status, gameConfig.gameSessionId, handleUpdateEmergencyLocation]);

  useEffect(() => () => emergencyHeartbeat.current.stop(), []);

  usePlayerAutoExpose({
    isOnline,
    currentUser,
    isAdmin,
    gameConfig,
    privateLocation,
    exposedLocations,
  });

  // 位置公開（スナップショット方式）
  // 押した瞬間のprivate locationをスナップショットとして5分間表示。
  // 本人がその後移動してもピンは動かない。
  const handleUpdateLocation = useCallback(async (): Promise<void> => {
    if (!currentUser || !gameConfig.gameSessionId || !canRevealLocation(gameConfig.gameStatus)) return;

    const confirmed = await confirm({
      title: '現在地の公開',
      description: '公開された座標は5分間地図上に固定表示されます。\n（その後移動してもピンはその場に残ります）',
      confirmLabel: '公開する',
      variant: 'primary',
    });
    if (!confirmed) return;

    const now = Date.now();
    const EXPOSE_DURATION = 5 * 60 * 1000; // 5 分
    const currentUserId = currentUser.id;
    const expectedSessionId = gameConfig.gameSessionId;

    // MapView が随時private locationを更新しているので、それをスナップショットとして使う
    const snapLat = privateLocation?.latitude;
    const snapLng = privateLocation?.longitude;

    if (snapLat == null || snapLng == null) {
      // Private Location がまだない場合は GPS から直接取得
      if (!('geolocation' in navigator)) {
        toast.error('このブラウザは位置情報に対応していません。');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        async pos => {
          try {
            const privateResult = await handleUpdatePrivateLocation({
              playerId: currentUserId,
              expectedSessionId,
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
            });
            if (!privateResult.ok) throw new Error(privateResult.reason);

            const exposeResult = await exposeLocation({
              playerId: currentUserId,
              expectedSessionId,
              privateLocation: {
                gameSessionId: expectedSessionId,
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
              },
              phase: gameConfig.gameStatus,
              now,
              duration: EXPOSE_DURATION,
            }, firebaseExposedLocationStore);
            if (exposeResult.ok === false) throw new Error(exposeResult.reason);

            toast.success('現在地を公開しました。5分後に自動で非公開になります。');
          } catch (error) {
            console.error('Location expose error:', error);
            toast.error('通信エラー：位置の公開に失敗しました。');
          }
        },
        error => {
          const msg = error.code === 3
            ? 'GPSの取得がタイムアウトしました。場所を変えてお試しください。'
            : '位置情報を取得できませんでした。';
          toast.error(msg);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
      return;
    }

    // private locationが存在する場合はそのままスナップショットとして書き込む
    try {
      const exposeResult = await exposeLocation({
        playerId: currentUser.id,
        expectedSessionId: gameConfig.gameSessionId ?? '',
        privateLocation: privateLocation?.gameSessionId === gameConfig.gameSessionId ? privateLocation : null,
        phase: gameConfig.gameStatus,
        now,
        duration: EXPOSE_DURATION,
      }, firebaseExposedLocationStore);
      if (exposeResult.ok === false) throw new Error(exposeResult.reason);

      toast.success('現在地を公開しました。5分後に自動で非公開になります。');
    } catch (error) {
      console.error('Location expose error:', error);
      toast.error('通信エラー：位置の公開に失敗しました。');
    }
  }, [confirm, currentUser, privateLocation, gameConfig.gameStatus, gameConfig.gameSessionId, handleUpdatePrivateLocation]);

  const handleUpdateLastStation = useCallback(async (
    stationName: string,
    options?: { silentToast?: boolean },
  ): Promise<void> => {
    if (!currentUser) return;
    try {
      await updatePlayerLastStation(currentUser.id, stationName);
      if (!options?.silentToast) {
        toast.success(`現在地を「${stationName}」に更新しました`);
      }
    } catch (error) {
      console.error('Failed to update player last station:', error);
      toast.error('現在地の更新に失敗しました');
      throw error;
    }
  }, [currentUser]);

  // Mission scoring, identity, duplicate enforcement, and logging are server-authoritative.
  const handleScoreUpdate = useCallback(
    (missionId: string) => {
      if (!gameConfig.gameSessionId) {
        toast.error('ゲームセッション初期化待ちです。管理者の操作後に再度お試しください。');
        return Promise.resolve({ ok: false as const, reason: 'SESSION_CHANGED' as const });
      }
      return completeMission({ missionId, expectedSessionId: gameConfig.gameSessionId }, firebaseMissionCompletionGateway);
    },
    [gameConfig.gameSessionId],
  );

  const handleSafetyAction = useCallback(async (
    action: SafetyAction,
    reasonCode: SafetyReasonCode,
  ): Promise<void> => {
    if (!currentUser || safetyActionBusyRef.current) return;
    if (action === 'RETIRE') {
      const confirmed = await confirm({
        title: 'リタイア確認',
        description: 'リタイアしますか？この操作は管理者のみが解除できます。',
        confirmLabel: 'リタイアする',
        variant: 'danger',
      });
      if (!confirmed) return;
    }

    safetyActionBusyRef.current = true;
    setSafetyActionBusy(true);
    try {
      if (!gameConfig.gameSessionId) {
        toast.error('ゲームセッション初期化待ちです。管理者の操作後に再度お試しください。');
        return;
      }
      const result = await requestSafetyAction({ action, reasonCode, expectedSessionId: gameConfig.gameSessionId }, firebaseSafetyActionGateway);
      setSafetyDialogOpen(false);
      if (result.ok === false) {
        toast.error(result.reason === 'RETIRED_TERMINAL'
          ? 'リタイア確定後はEmergencyへ変更できません。必要な場合はLINE等で管理者へ直接連絡してください。'
          : '送信に失敗しました。緊急の場合はLINE等で直接連絡してください。');
        return;
      }

      const locationUpdated = action === 'EMERGENCY'
        ? await updateEmergencyLocationOnce({
            status: 'EMERGENCY',
            playerId: currentUser.id,
            expectedSessionId: gameConfig.gameSessionId,
            authUserId: currentUser.id,
            geolocation: 'geolocation' in navigator ? navigator.geolocation : null,
            updatePrivateLocation: handleUpdateEmergencyLocation,
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
        toast.info(`${message}\n${locationMessage}`);
      } else {
        toast.success(message);
      }
    } finally {
      safetyActionBusyRef.current = false;
      setSafetyActionBusy(false);
    }
  }, [confirm, currentUser, handleUpdateEmergencyLocation, gameConfig.gameSessionId]);

  // Capture validation, state changes, reward, and logging are server-authoritative.
  const handleCapture = useCallback(async (targetId: string): Promise<void> => {
    if (!currentUser) return;

    const target = allUsers.find(user => user.id === targetId);
    if (!target) return;

    const confirmed = await confirm({
      title: '捕獲確認',
      description: `${target.name} を捕獲しましたか？`,
      confirmLabel: '捕獲した',
      variant: 'primary',
    });
    if (!confirmed) return;

    if (!gameConfig.gameSessionId) {
      toast.error('ゲームセッション初期化待ちです。管理者の操作後に再度お試しください。');
      return;
    }
    const result = await capturePlayer({ targetId, expectedSessionId: gameConfig.gameSessionId }, firebaseCaptureGateway);
    if (result.ok === false) {
      toast.error(result.reason === 'CAPTURE_REJECTED'
        ? 'このプレイヤーは捕獲できません。'
        : '捕獲処理に失敗しました。');
    } else {
      toast.success(`${target.name} を捕獲しました！`);
    }
  }, [confirm, currentUser, allUsers, gameConfig.gameSessionId]);

  // 無敵カード使用
  const handleActivateInvincibility = useCallback(async (): Promise<void> => {
    if (!currentUser) return;

    const invincibilityMinutes = Math.round(INVINCIBILITY_DURATION_MS / 60000);
    const confirmed = await confirm({
      title: '無敵カード使用',
      description: `無敵カードを使いますか？（${invincibilityMinutes}分間有効）`,
      confirmLabel: '使用する',
      variant: 'primary',
    });
    if (!confirmed) return;

    if (!gameConfig.gameSessionId) {
      toast.error('ゲームセッション初期化待ちです。管理者の操作後に再度お試しください。');
      return;
    }
    const result = await activateInvincibility({ expectedSessionId: gameConfig.gameSessionId }, firebaseInvincibilityGateway);
    if (result.ok === false) {
      toast.error(result.reason === 'NO_CARDS'
        ? '無敵カードがありません。'
        : '現在の状態では無敵カードを使用できません。');
      return;
    }

    toast.success('無敵モード発動！');
  }, [confirm, currentUser, gameConfig.gameSessionId]);

  // Waiting eligibility, deadline, persistence, and logging are server-authoritative.
  const handleStartShinkansenWait = useCallback(async (): Promise<void> => {
    if (!currentUser) return;

    const waitMinutes = gameConfig.postShinkansenWaitMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.postShinkansenWaitMinutes;
    const confirmed = await confirm({
      title: '待機開始',
      description: `新幹線移動（${waitMinutes}分待機）を開始しますか？`,
      confirmLabel: '開始する',
      variant: 'primary',
    });
    if (!confirmed) return;

    if (!gameConfig.gameSessionId) {
      toast.error('ゲームセッション初期化待ちです。管理者の操作後に再度お試しください。');
      return;
    }

    const result = await startWaiting({ expectedSessionId: gameConfig.gameSessionId }, firebaseWaitingGateway);
    if (!result.ok) {
      toast.error('現在の状態では待機を開始できません。');
      return;
    }
    toast.success('待機モードに入りました。お疲れ様でした。');
  }, [confirm, currentUser, gameConfig.gameSessionId, gameConfig.postShinkansenWaitMinutes]);

  const handleResumeWaiting = useCallback(async (): Promise<void> => {
    if (!gameConfig.gameSessionId) return;
    const result = await resumeWaiting({ expectedSessionId: gameConfig.gameSessionId }, firebaseWaitingGateway);
    if (result.ok === false) console.error('Waiting resume request was rejected:', result.reason);
  }, [gameConfig.gameSessionId]);

  const handleUpdateProtectionZone = useCallback(async (zone: ProtectionZoneType): Promise<void> => {
    if (!currentUser) return;
    try {
      await updatePlayerProtectionZone(currentUser.id, zone);
      const label = zone === 'NONE' ? '通常モード' : zone === 'GREEN_CAR' ? 'グリーン席（特例保護）' : 'セーフゾーン（特例保護）';
      toast.success(`保護エリア宣言: ${label}`);
    } catch (err) {
      console.error('Failed to update protection zone:', err);
      toast.error('保護エリアの更新に失敗しました');
    }
  }, [currentUser]);

  const handleStartShinkansen = useCallback(async (): Promise<void> => {
    if (!currentUser) return;
    try {
      await startPlayerShinkansen(currentUser.id);
      toast.success('新幹線乗車を開始しました。タイマーがスタートしました。');
    } catch (err) {
      console.error('Failed to start shinkansen:', err);
      toast.error('新幹線乗車の開始に失敗しました');
    }
  }, [currentUser]);

  const handleIncrementShinkansenSegment = useCallback(async (): Promise<void> => {
    if (!currentUser) return;
    try {
      await incrementPlayerShinkansenSegment(currentUser.id);
      toast.info(`新幹線区間数を記録しました（現在: ${(currentUser.shinkansenSegmentCount ?? 0) + 1}区間）`);
    } catch (err) {
      console.error('Failed to increment shinkansen segment:', err);
      toast.error('区間数の更新に失敗しました');
    }
  }, [currentUser]);

  const handleResetShinkansen = useCallback(async (): Promise<void> => {
    if (!currentUser) return;
    try {
      await resetPlayerShinkansen(currentUser.id);
      toast.info('新幹線乗車記録をリセットしました');
    } catch (err) {
      console.error('Failed to reset shinkansen:', err);
    }
  }, [currentUser]);

  useWaitingAutoResume({
    isOnline,
    status: currentUser?.status,
    waitingUntil: currentUser?.waitingUntil,
    gameSessionId: gameConfig.gameSessionId,
  });

  // ---- 画面分岐 ----

  if (!authReady || userLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">
        <LoadingSpinner message="ゲームデータを読み込み中..." />
      </div>
    );
  }

  const gamePaused = isGamePaused(gameConfig.gameStatus);
  const aScore = gameConfig.teamAScore ?? 0;
  const bScore = gameConfig.teamBScore ?? 0;
  const winner = determineGameWinner({
    victoryMode: gameConfig.victoryMode,
    teamAScore: aScore,
    teamBScore: bScore,
    teamARole: gameConfig.teamARole,
    teamBRole: gameConfig.teamBRole,
    players: allUsers,
  });


  return (
    <HashRouter>
      <Toaster position="top-center" richColors />
      <ConfirmDialog {...dialogProps} />

      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-[5000] bg-red-600 text-white text-xs py-1.5 px-4 font-bold flex items-center justify-center gap-2 shadow-md">
          <WifiOff size={14} className="animate-pulse" />
          <span>通信が切断されています（オフラインモード）</span>
        </div>
      )}

      {isAdminPath || isAdmin ? (
        <div className="flex flex-col h-screen max-w-md mx-auto bg-slate-50 shadow-2xl overflow-hidden relative font-sans">
          <Suspense fallback={<LoadingSpinner message="管理者画面を読み込み中..." />}>
            <Routes>
              <Route
                path="/admin"
                element={<AdminView config={gameConfig} users={allUsers} missions={missions} />}
              />
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </Suspense>
        </div>
      ) : !currentUser ? (
        <Suspense fallback={<LoadingSpinner message="セットアップ画面を読み込み中..." />}>
          <SetupView onComplete={setCurrentUser} gameSessionId={gameConfig.gameSessionId} />
        </Suspense>
      ) : (gameConfig.gameStatus === 'GAME_OVER' || gameConfig.isGameOver) ? (
        <FinalResultView
          winner={winner}
          aScore={aScore}
          bScore={bScore}
          logs={gameConfig.logs ?? []}
          safetyDialogOpen={safetyDialogOpen}
          safetyActionBusy={safetyActionBusy}
          onOpenSafetyDialog={() => setSafetyDialogOpen(true)}
          onCloseSafetyDialog={() => setSafetyDialogOpen(false)}
          onChooseSafetyAction={handleSafetyAction}
          onSignOutAndReload={async () => {
            await signOutCurrentUser();
            window.location.reload();
          }}
        />
      ) : (
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
              ゲーム操作は一時停止中です。待機時間や無敵時間などの期限は進行します。
            </div>
            <button
              type="button"
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
              type="button"
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
            <Suspense fallback={<LoadingSpinner message="画面を読み込み中..." />}>
              <Routes>
                <Route
                  path="/map"
                  element={
                    <MapView
                      users={allUsers}
                      logs={locationLogs}
                      currentUser={currentUser}
                      privateLocation={privateLocation?.gameSessionId === gameConfig.gameSessionId ? privateLocation : null}
                      exposedLocations={exposedLocations}
                      gameConfig={gameConfig}
                      onUpdatePrivateLocation={handleUpdatePrivateLocation}
                      onCapture={handleCapture}
                      onActivateInvincibility={handleActivateInvincibility}
                      onStartShinkansenWait={handleStartShinkansenWait}
                      onResumeWaiting={handleResumeWaiting}
                      onUpdateLastStation={handleUpdateLastStation}
                      onUpdateProtectionZone={handleUpdateProtectionZone}
                      onStartShinkansen={handleStartShinkansen}
                      onIncrementShinkansenSegment={handleIncrementShinkansenSegment}
                      onResetShinkansen={handleResetShinkansen}
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
                  path="/admin"
                  element={
                    <AdminView
                      config={gameConfig}
                      users={allUsers}
                      missions={missions}
                    />
                  }
                />
                <Route path="*" element={<Navigate to="/map" replace />} />
              </Routes>
            </Suspense>
          )}

          {isAdmin && (
            <Link
              to="/admin"
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
      )}
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
