import type React from 'react';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { User, PrivateLocation, ExposedLocation, LocationLog, GameConfig, Role, ProtectionZoneType } from '../types';
import { DEFAULT_DYNAMIC_RULE_SETTINGS } from '../constants';
import type { Coordinates, UpdatePrivateLocationResult } from '../src/application';
import {
  canUpdatePrivateLocation,
  calculateHaversineDistanceMeters,
  formatDistanceMeters,
  getPlayerRole,
  isActiveUntil,
  isGameActive,
  isGamePaused,
  resolveLocationVisibility,
  isWaitingActive,
  ONI_INITIAL_LOCK_DURATION_MS,
  remainingSeconds,
  shouldThrottleLocationUpdate,
} from '../src/game';
import { Clock, Train, MapPin, AlertCircle, Lock, WifiOff, Shield } from 'lucide-react';
import L from '../src/lib/leafletSetup';
import { createPlayerMapPopup, type PlayerMapPopupVariant } from './playerMapPopup';
import useWakeLock from '../src/hooks/useWakeLock';
import useOnlineStatus from '../src/hooks/useOnlineStatus';

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

import { toast } from 'sonner';
import {
  findCandidateTransitSuggestions,
  findTransitSuggestion,
  type StationData,
  type TransitSuggestion,
} from '../src/game';
import stationsData from '../src/data/stations.json';
import StationSuggestCard from '../src/components/StationSuggestCard';

interface Props {
  users: User[];
  logs: LocationLog[];
  currentUser: User;
  privateLocation: PrivateLocation | null;
  exposedLocations: Record<string, ExposedLocation>;
  gameConfig: GameConfig;
  onUpdatePrivateLocation: (input: Coordinates & { playerId: string; expectedSessionId: string }) => Promise<UpdatePrivateLocationResult>;
  onCapture: (runnerId: string) => Promise<void>;
  onActivateInvincibility: () => Promise<void>;
  onStartShinkansenWait: () => Promise<void>;
  onResumeWaiting?: () => Promise<void>;
  onUpdateLastStation?: (stationName: string) => Promise<void>;
  onUpdateProtectionZone?: (zone: ProtectionZoneType) => Promise<void>;
  onStartShinkansen?: () => Promise<void>;
  onIncrementShinkansenSegment?: () => Promise<void>;
  onResetShinkansen?: () => Promise<void>;
}

const MapView: React.FC<Props> = ({
  users, currentUser, privateLocation, exposedLocations, gameConfig, onUpdatePrivateLocation, onCapture, onActivateInvincibility, onStartShinkansenWait, onResumeWaiting: _onResumeWaiting, onUpdateLastStation, onUpdateProtectionZone, onStartShinkansen, onIncrementShinkansenSegment, onResetShinkansen
}) => {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<Record<string, L.CircleMarker>>({});
  const [timeLeft, setTimeLeft] = useState({
    waiting: 0, invincible: 0, nextReveal: 0, final: 0, oniLock: 0, shinkansenRemaining: 0, forceReveal: 0, teamSearchRemaining: 0, penaltyRemaining: 0
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const isOnline = useOnlineStatus();
  const isOffline = !isOnline;
  const watchId = useRef<number | null>(null);
  const lastUploadTime = useRef<number>(0);
  const lastUploadedCoords = useRef<Coordinates | null>(null);

  const [transitSuggestion, setTransitSuggestion] = useState<TransitSuggestion | null>(null);
  const [transitCandidates, setTransitCandidates] = useState<TransitSuggestion[]>([]);
  const [isSuggestDismissed, setIsSuggestDismissed] = useState(false);
  const lastDismissedKey = useRef<string | null>(null);
  const prevCoordsRef = useRef<Coordinates | null>(null);

  const [isAutoUpdateEnabled, setIsAutoUpdateEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('transit_auto_update_enabled') === 'true';
    } catch {
      return false;
    }
  });

  const handleToggleAutoUpdate = (enabled: boolean) => {
    setIsAutoUpdateEnabled(enabled);
    try {
      localStorage.setItem('transit_auto_update_enabled', String(enabled));
    } catch (e) {
      console.error('Failed to save auto update preference:', e);
    }
    if (enabled) {
      toast.success('現在地の自動反映をONにしました');
    } else {
      toast.info('現在地の自動反映をOFFにしました');
    }
  };

  useEffect(() => {
    if (!privateLocation) {
      setTransitSuggestion(null);
      setTransitCandidates([]);
      prevCoordsRef.current = null;
      return;
    }
    const currentCoords: Coordinates = {
      latitude: privateLocation.latitude,
      longitude: privateLocation.longitude,
    };
    const previousCoords = prevCoordsRef.current;

    const suggestion = findTransitSuggestion(currentCoords, stationsData as StationData[], {
      previousCoords,
    });
    const candidates = findCandidateTransitSuggestions(currentCoords, stationsData as StationData[], {
      previousCoords,
    });

    prevCoordsRef.current = currentCoords;
    setTransitCandidates(candidates);
    setTransitSuggestion(suggestion);

    if (suggestion && suggestion.displayText !== lastDismissedKey.current) {
      setIsSuggestDismissed(false);
    }
  }, [privateLocation]);

  // Phase 3: 自動反映（オートチェックイン）ロジック
  const stableSuggestionRef = useRef<{ text: string; count: number }>({ text: '', count: 0 });
  const lastAutoUpdatedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!isAutoUpdateEnabled || !transitSuggestion || !onUpdateLastStation) {
      return;
    }

    const currentTarget = transitSuggestion.displayText;

    // 既に現在地として記録されている場合はスキップ
    if (currentUser.lastStation === currentTarget || lastAutoUpdatedKey.current === currentTarget) {
      stableSuggestionRef.current = { text: currentTarget, count: 0 };
      return;
    }

    // 安定化カウンター（GPSノイズ防止のため2回連続で同一判定となった場合に確定）
    if (stableSuggestionRef.current.text === currentTarget) {
      stableSuggestionRef.current.count += 1;
    } else {
      stableSuggestionRef.current = { text: currentTarget, count: 1 };
    }

    if (stableSuggestionRef.current.count >= 2) {
      lastAutoUpdatedKey.current = currentTarget;
      onUpdateLastStation(currentTarget)
        .then(() => {
          toast.success(`現在地を自動更新しました: ${currentTarget}`, {
            duration: 3500,
          });
        })
        .catch(err => {
          console.error('Failed to auto update station:', err);
        });
    }
  }, [transitSuggestion, isAutoUpdateEnabled, currentUser.lastStation, onUpdateLastStation]);

  const handleConfirmStation = async (stationName: string) => {
    if (!onUpdateLastStation) return;
    try {
      await onUpdateLastStation(stationName);
      setIsSuggestDismissed(true);
      if (transitSuggestion) {
        lastDismissedKey.current = transitSuggestion.displayText;
      }
    } catch (error) {
      console.error('Failed to update station:', error);
    }
  };

  // Keep screen awake while MapView is active
  useWakeLock(true);

  const currentRole: Role = getPlayerRole(currentUser, gameConfig);
  const captureCandidates = currentRole === 'ONI'
    ? users.filter(user => (
      user.id !== currentUser.id &&
      user.status === 'ACTIVE' &&
      getPlayerRole(user, gameConfig) === 'RUNNER' &&
      !isActiveUntil(user.invincibleUntil, Date.now())
    ))
    : [];

  useEffect(() => {
    if (!captureCandidates.some(user => user.id === selectedTargetId)) {
      setSelectedTargetId(captureCandidates[0]?.id ?? '');
    }
  }, [captureCandidates, selectedTargetId]);

  // 位置情報更新 (30m 移動 または 5分間隔フォールバックによるBaaS書き込みクォータ保護)
  const updateLocation = useCallback(async (position: GeolocationPosition) => {
    if (!currentUser || !gameConfig.gameSessionId || !canUpdatePrivateLocation(gameConfig.gameStatus)) return;
    if (!navigator.onLine) return;

    const now = Date.now();
    const currentCoords: Coordinates = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };

    const decision = shouldThrottleLocationUpdate({
      currentCoords,
      currentAccuracy: position.coords.accuracy,
      currentTimeMs: now,
      lastUploadedCoords: lastUploadedCoords.current,
      lastUploadedTimeMs: lastUploadTime.current,
    });

    if (!decision.shouldUpload) return;

    try {
      const result = await onUpdatePrivateLocation({
        playerId: currentUser.id,
        expectedSessionId: gameConfig.gameSessionId,
        latitude: currentCoords.latitude,
        longitude: currentCoords.longitude,
      });
      if (!result.ok) {
        console.error('Failed to update private location:', result.reason);
        return;
      }
      lastUploadTime.current = now;
      lastUploadedCoords.current = currentCoords;
    } catch (error) {
      console.error('Failed to update location:', error);
    }
  }, [currentUser, gameConfig.gameStatus, gameConfig.gameSessionId, onUpdatePrivateLocation]);

  // watchPosition with Page Visibility optimization (Battery saving when app/tab is backgrounded)
  useEffect(() => {
    if (!currentUser || !('geolocation' in navigator)) return;

    const startWatching = () => {
      if (watchId.current) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = navigator.geolocation.watchPosition(
        position => {
          updateLocation(position);
        },
        error => console.error('Geolocation watch error:', error),
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 }
      );
    };

    const stopWatching = () => {
      if (watchId.current) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }
    };

    if (document.visibilityState === 'visible') {
      startWatching();
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        startWatching();
      } else {
        stopWatching();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopWatching();
    };
  }, [currentUser, updateLocation]);

  // タイマー
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      if (isGamePaused(gameConfig.gameStatus)) {
        const waiting = isWaitingActive(currentUser.status, currentUser.waitingUntil, now)
          ? remainingSeconds(currentUser.waitingUntil, now)
          : 0;
        setTimeLeft(previous => ({ ...previous, waiting }));
        return;
      }

      // 管理者強制開示の残り時間を計算
      const forceReveal = remainingSeconds(gameConfig.locationRevealUntil, now);

      const myTeamRevealUntil = currentUser.team === 'A'
        ? gameConfig.teamARevealUntil
        : gameConfig.teamBRevealUntil;
      const teamSearchRemaining = remainingSeconds(myTeamRevealUntil, now);
      const waiting = isWaitingActive(currentUser.status, currentUser.waitingUntil, now)
        ? remainingSeconds(currentUser.waitingUntil, now)
        : 0;
      const invincible = remainingSeconds(currentUser.invincibleUntil, now);
      const final = gameConfig.isFinalMissionActive
        ? remainingSeconds(gameConfig.finalMissionEndTime, now)
        : 0;

      const oniLockTime = (gameConfig.startTime || 0) + ONI_INITIAL_LOCK_DURATION_MS;
      const oniLock = currentRole === 'ONI' ? remainingSeconds(oniLockTime, now) : 0;
      const nextReveal = remainingSeconds(gameConfig.nextRevealTime, now);

      const shinkansenLimitMinutes = gameConfig.shinkansenMaxMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxMinutes;
      let shinkansenRemaining = Infinity;
      if (shinkansenLimitMinutes > 0) {
        const shinkansenLimitMs = shinkansenLimitMinutes * 60 * 1000;
        const shinkansenUntil = currentUser.shinkansenStartTime
          ? currentUser.shinkansenStartTime + shinkansenLimitMs
          : undefined;
        shinkansenRemaining = remainingSeconds(shinkansenUntil, now);
      }
      const penaltyRemaining = remainingSeconds(currentUser.penaltyRevealUntil, now);

      setTimeLeft({ waiting, invincible, nextReveal, final, oniLock, shinkansenRemaining, forceReveal, teamSearchRemaining, penaltyRemaining });
    }, 1000);
    return () => clearInterval(timer);
  }, [currentUser, gameConfig, currentRole]);

  // チーム同一行動の距離判定（規定: チームメンバーと1.5km以上離れた場合は警告）
  const teammateDistances = useMemo(() => {
    if (!privateLocation || !currentUser.team) return [];
    const myCoords: Coordinates = { latitude: privateLocation.latitude, longitude: privateLocation.longitude };

    return users
      .filter(u => u.id !== currentUser.id && u.team === currentUser.team && u.status === 'ACTIVE')
      .map(teammate => {
        const exp = exposedLocations[teammate.id];
        if (exp && typeof exp.latitude === 'number' && typeof exp.longitude === 'number') {
          const dist = calculateHaversineDistanceMeters(myCoords, { latitude: exp.latitude, longitude: exp.longitude });
          return { teammate, distanceMeters: dist };
        }
        return null;
      })
      .filter((item): item is { teammate: User; distanceMeters: number } => item !== null);
  }, [privateLocation, currentUser.id, currentUser.team, users, exposedLocations]);

  const maxTeammateDistance = teammateDistances.length > 0
    ? Math.max(...teammateDistances.map(d => d.distanceMeters))
    : 0;

  const isTeamSplitAlert = maxTeammateDistance > 1500;


  // 地図初期化（GPS更新のたびに破棄・再生成しないよう oniLock のみに依存）
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial map coordinates only, not recreated on GPS updates
  useEffect(() => {
    if (!containerRef.current || timeLeft.oniLock > 0) return;
    if (!mapRef.current) {
      const map = L.map(containerRef.current).setView(
        [privateLocation?.latitude ?? 35.6812, privateLocation?.longitude ?? 139.7671], 13
      );
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
      mapRef.current = map;
    }

    return () => {
      // Map cleanup on unmount
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [timeLeft.oniLock]);

// ── マーカー描画（強制共有・チーム別サーチ対応版） ────────────────────────
  useEffect(() => {
    const currentMap = mapRef.current;
    if (!currentMap) return;

    // 既存マーカーを全削除
    Object.values(markersRef.current).forEach((m: L.CircleMarker) => {
      m.remove();
    });
    markersRef.current = {};

    const now = Date.now();

    users.forEach(user => {
      const visibility = resolveLocationVisibility({
        viewerId: currentUser.id,
        player: {
          ...user,
          penaltyRevealUntil: user.penaltyRevealUntil,
          ...(user.id === currentUser.id && privateLocation
            ? { privateLatitude: privateLocation.latitude, privateLongitude: privateLocation.longitude }
            : {}),
          ...(exposedLocations[user.id]
            ? { exposedLocation: exposedLocations[user.id] }
            : {}),
        },
        phase: gameConfig.gameStatus,
        now,
        globalRevealUntil: gameConfig.locationRevealUntil,
        teamARevealUntil: gameConfig.teamARevealUntil,
        teamBRevealUntil: gameConfig.teamBRevealUntil,
      });

      if (visibility.mode === 'HIDDEN' || visibility.latitude === undefined || visibility.longitude === undefined) return;

      const isSelf = visibility.mode === 'SELF_PRIVATE';
      const isTeamSearchActive = visibility.mode === 'TEAM_SNAPSHOT';
      const isGlobalForceReveal = visibility.mode === 'GLOBAL_SNAPSHOT';
      const isPenaltyActive = visibility.mode === 'PENALTY_SNAPSHOT';
      const isInvincible = isActiveUntil(user.invincibleUntil, now);

      const marker = L.circleMarker([visibility.latitude, visibility.longitude], {
        radius: isSelf ? 10 : 8,
        fillColor: isPenaltyActive
          ? '#dc2626'
          : isTeamSearchActive
            ? '#ef4444'
            : isGlobalForceReveal
              ? '#f59e0b'
              : user.color,
        color: isPenaltyActive ? '#7f1d1d' : isInvincible ? '#fbbf24' : '#fff',
        weight: isPenaltyActive || isInvincible ? 4 : 3,
        opacity: 1,
        fillOpacity: isSelf ? 0.95 : isTeamSearchActive || isPenaltyActive ? 0.95 : 0.7,
      }).addTo(currentMap);

      let popupVariant: PlayerMapPopupVariant;
      let remainingTime: string | undefined;
      if (isSelf) {
        popupVariant = 'SELF';
      } else if (isPenaltyActive) {
        popupVariant = 'PENALTY';
        const remainSec = remainingSeconds(visibility.expiresAt, now);
        remainingTime = formatTime(remainSec);
      } else if (isTeamSearchActive) {
        popupVariant = 'TEAM_SEARCH';
      } else if (isGlobalForceReveal) {
        popupVariant = 'GLOBAL_REVEAL';
      } else {
        popupVariant = 'EXPOSED';
        const remainSec = remainingSeconds(visibility.expiresAt, now);
        remainingTime = formatTime(remainSec);
      }

      marker.bindPopup(createPlayerMapPopup(document, user, popupVariant, remainingTime));
      markersRef.current[user.id] = marker;
    });
  }, [
    users, 
    currentUser,
    privateLocation,
    exposedLocations,
    gameConfig.locationRevealUntil, 
    gameConfig.teamARevealUntil, 
    gameConfig.teamBRevealUntil,
    gameConfig.gameStatus,
  ]); // 依存配列にチーム別の開示期限を追加
  
  if (timeLeft.oniLock > 0) {
    return (
      <div className="h-full bg-slate-900 flex flex-col items-center justify-center p-6 text-center text-white">
        <div className="w-24 h-24 bg-red-600/20 rounded-full flex items-center justify-center mb-8 border-4 border-red-600/30 animate-pulse">
          <Lock size={48} className="text-red-500" />
        </div>
        <h2 className="text-3xl font-black mb-2 italic tracking-tighter uppercase">ONI WAITING...</h2>
        <p className="text-slate-400 font-bold mb-12 uppercase tracking-widest text-xs leading-relaxed">
          逃走者の移動開始から30分間は、<br />鬼は待機しなければなりません。
        </p>
        <div className="bg-slate-800 px-10 py-6 rounded-3xl border border-slate-700 shadow-2xl">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Time to Release</div>
          <div className="text-5xl font-black font-mono text-white">{formatTime(timeLeft.oniLock)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      {isOffline && (
        <div className="z-[1002] bg-orange-600 text-white text-[10px] font-black py-1 px-4 flex items-center justify-center gap-2">
          <WifiOff size={12} /> 通信断：位置更新を一時停止中
        </div>
      )}



  {/* ゲームステータスヘッダー */}
  {timeLeft.penaltyRemaining > 0 ? (
    /* 🚨 ペナルティ開示の表示：最優先・濃赤色 */
    <div className="z-[1001] px-4 py-2 bg-red-700 text-white text-center text-xs font-black animate-pulse flex items-center justify-center gap-2">
      <AlertCircle size={14} /> 🚨 【ペナルティ】位置情報常時公開中！ 残り {formatTime(timeLeft.penaltyRemaining)}
    </div>
  ) : timeLeft.teamSearchRemaining > 0 ? (
    /* 🚨 チーム別サーチ中（ペナルティ等）の表示：最優先・赤色 */
    <div className="z-[1001] px-4 py-2 bg-red-600 text-white text-center text-xs font-black animate-pulse flex items-center justify-center gap-2">
      <AlertCircle size={14} /> 【警告】チーム位置スナップショット公開中！ 残り {formatTime(timeLeft.teamSearchRemaining)}
    </div>
  ) : timeLeft.forceReveal > 0 ? (
    /* ⚠️ 管理者による全員スナップショット公開中の表示：オレンジ */
    <div className="z-[1001] px-4 py-2 bg-amber-500 text-white text-center text-xs font-black flex items-center justify-center gap-2">
      <MapPin size={14} /> 管理者による位置強制公開中！ 残り {formatTime(timeLeft.forceReveal)}
    </div>

  ) : timeLeft.nextReveal > 0 ? (
    <div className="z-[1001] px-4 py-2 bg-indigo-600 text-white text-center text-xs font-black flex items-center justify-center gap-2">
      <Clock size={14} /> 次の位置公開まで {formatTime(timeLeft.nextReveal)}（開示: {gameConfig.periodicRevealDurationMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealDurationMinutes}分間 / 間隔: {gameConfig.periodicRevealIntervalMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealIntervalMinutes}分）
    </div>

  ) : gameConfig.isFinalMissionActive ? (
    /* 🏁 最終ミッション中の表示：赤色 */
    <div className="z-[1001] px-4 py-2 bg-slate-900 text-red-500 text-center text-xs font-black animate-pulse flex items-center justify-center gap-2 border-b border-red-500/50">
      <AlertCircle size={14} /> 最終ミッション発動中！ 残り {Math.floor(timeLeft.final / 60)}分
    </div>
  ) : null}

  {/* チーム同一行動違反警告バナー */}
  {isTeamSplitAlert && (
    <div className="z-[1001] px-4 py-1.5 bg-amber-600 text-white text-center text-xs font-black flex items-center justify-center gap-2">
      <AlertCircle size={14} /> 【同一行動規定】チームメンバーと離れすぎています（約{formatDistanceMeters(maxTeammateDistance)}）。単独行動・挟み撃ちは禁止です。
    </div>
  )}

      <div ref={containerRef} style={{ flex: 1, width: '100%', zIndex: 0 }} />

      {/* 最寄り駅・路線の自動提案カード */}
      {!isSuggestDismissed && transitSuggestion && onUpdateLastStation && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[1001] w-full px-4 max-w-sm pointer-events-none">
          <StationSuggestCard
            suggestion={transitSuggestion}
            candidates={transitCandidates}
            currentLastStation={currentUser.lastStation}
            onConfirmStation={handleConfirmStation}
            onDismiss={() => {
              setIsSuggestDismissed(true);
              if (transitSuggestion) {
                lastDismissedKey.current = transitSuggestion.displayText;
              }
            }}
            isAutoUpdateEnabled={isAutoUpdateEnabled}
            onToggleAutoUpdate={handleToggleAutoUpdate}
          />
        </div>
      )}

      <div className="absolute top-16 left-4 z-[1000] flex flex-col gap-2 pointer-events-none">
        {currentUser.lastStation && (
          <div className="bg-slate-900/95 backdrop-blur text-blue-400 px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg border border-slate-700/60 flex items-center gap-1.5">
            <Train size={12} className="text-blue-400 shrink-0" />
            <span className="text-slate-200 truncate max-w-[140px]">{currentUser.lastStation}</span>
          </div>
        )}
        {currentUser.protectionZone && currentUser.protectionZone !== 'NONE' && (
          <div className="bg-emerald-600 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg flex items-center gap-1">
            <Shield size={12} /> {currentUser.protectionZone === 'GREEN_CAR' ? 'グリーン席保護中' : 'セーフゾーン中'}
          </div>
        )}
        {timeLeft.invincible > 0 && (
          <div className="bg-amber-500 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg">
            無敵中: {formatTime(timeLeft.invincible)}
          </div>
        )}
        {timeLeft.waiting > 0 && (
          <div className="bg-slate-900 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg">
            待機中: {formatTime(timeLeft.waiting)}
          </div>
        )}
        {timeLeft.shinkansenRemaining > 0 && currentUser.status === 'ACTIVE' && (
          <div className="bg-blue-600 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg flex items-center gap-1">
            <Train size={12} /> 新幹線移動: {formatTime(timeLeft.shinkansenRemaining)}
          </div>
        )}
      </div>

      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-[1000] w-full px-6 flex flex-col items-center gap-3">
        {currentRole === 'ONI' && (() => {
          const selectedTarget = users.find(user => user.id === selectedTargetId);
          const isSelectedTargetProtected = Boolean(
            selectedTarget?.protectionZone &&
            selectedTarget.protectionZone !== 'NONE'
          );

          return (
            <div className="w-full max-w-sm flex flex-col gap-2">
              <label className="text-xs font-bold text-slate-600 text-center" htmlFor="capture-target">
                捕獲対象
              </label>
              <select
                id="capture-target"
                value={selectedTargetId}
                onChange={event => setSelectedTargetId(event.target.value)}
                disabled={isProcessing || captureCandidates.length === 0}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold shadow-xl disabled:bg-slate-100"
              >
                {captureCandidates.length === 0 ? (
                  <option value="">捕獲可能な逃走者はいません</option>
                ) : (
                  captureCandidates.map(user => {
                    const isProtected = user.protectionZone && user.protectionZone !== 'NONE';
                    const tag = isProtected
                      ? ` [🛡️ ${user.protectionZone === 'GREEN_CAR' ? 'グリーン席保護' : 'セーフゾーン'}]`
                      : '';
                    return (
                      <option key={user.id} value={user.id}>
                        {user.name}{tag}
                      </option>
                    );
                  })
                )}
              </select>
              <button
                type="button"
                onClick={async () => {
                  setIsProcessing(true);
                  try { await onCapture(selectedTargetId); }
                  finally { setIsProcessing(false); }
                }}
                disabled={
                  isProcessing || !selectedTargetId || captureCandidates.length === 0 ||
                  currentUser.status === 'WAITING' || gameConfig.gameStatus.includes('_PAUSED') ||
                  isSelectedTargetProtected
                }
                className={`px-10 py-4 rounded-full font-black text-lg shadow-2xl transition-all ${
                  isProcessing || !selectedTargetId || captureCandidates.length === 0 ||
                  currentUser.status === 'WAITING' || gameConfig.gameStatus.includes('_PAUSED') ||
                  isSelectedTargetProtected
                    ? 'bg-slate-400 text-white cursor-not-allowed'
                    : 'bg-slate-900 text-white active:scale-95'
                }`}
              >
                {isSelectedTargetProtected ? '🛡️ 特例保護エリア宣言中のため捕獲不可' : '捕獲ボタン'}
              </button>
            </div>
          );
        })()}
        {currentRole === 'RUNNER' && (
          <div className="w-full max-w-sm flex flex-col items-center gap-2">
            {/* 特例保護エリア切り替えセレクター */}
            <div className="w-full flex items-center justify-between gap-1.5 bg-white/95 backdrop-blur-md px-3 py-2 rounded-2xl border border-slate-200 shadow-xl">
              <span className="text-[10px] font-black text-slate-500 shrink-0">特例保護:</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => onUpdateProtectionZone?.('NONE')}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold transition-all ${
                    (!currentUser.protectionZone || currentUser.protectionZone === 'NONE')
                      ? 'bg-slate-800 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  通常
                </button>
                <button
                  type="button"
                  onClick={() => onUpdateProtectionZone?.('GREEN_CAR')}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold transition-all ${
                    currentUser.protectionZone === 'GREEN_CAR'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  🛡️ グリーン席
                </button>
                <button
                  type="button"
                  onClick={() => onUpdateProtectionZone?.('SAFE_ZONE')}
                  className={`px-2.5 py-1 rounded-xl text-xs font-bold transition-all ${
                    currentUser.protectionZone === 'SAFE_ZONE'
                      ? 'bg-teal-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  🛡️ セーフゾーン
                </button>
              </div>
            </div>

            {/* 新幹線乗車中 HUD 兼 アクション */}
            {currentUser.shinkansenStartTime ? (
              <div className="flex flex-col gap-2 w-full">
                {(() => {
                  const maxMinutes = gameConfig.shinkansenMaxMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxMinutes;
                  const maxSegments = gameConfig.shinkansenMaxSegments ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxSegments;
                  const isTimeReached = maxMinutes > 0 && timeLeft.shinkansenRemaining <= 0;
                  const isSegmentReached = maxSegments > 0 && (currentUser.shinkansenSegmentCount ?? 0) >= maxSegments;
                  if (!isTimeReached && !isSegmentReached) return null;
                  return (
                    <div className="bg-red-600 text-white text-[11px] font-bold p-2.5 rounded-2xl text-center shadow-lg animate-pulse">
                      ⚠️ 新幹線利用上限（{maxMinutes > 0 ? `最長${maxMinutes}分` : '時間無制限'}{maxSegments > 0 ? ` / 最大${maxSegments}区間` : ''}）に達しました！速やかに下車してください。
                    </div>
                  );
                })()}
                <div className="bg-slate-900/95 backdrop-blur-md text-white p-3 rounded-2xl flex items-center justify-between shadow-xl border border-slate-700">
                  <div className="flex items-center gap-2">
                    <Train size={20} className="text-blue-400 animate-pulse" />
                    <div>
                      <div className="text-[10px] font-bold text-slate-400">🚄 新幹線乗車中</div>
                      <div className="text-xs font-black">
                        残り: <span className="font-mono text-amber-400">{(gameConfig.shinkansenMaxMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxMinutes) > 0 ? formatTime(timeLeft.shinkansenRemaining) : '無制限'}</span>
                        {' / '}
                        <span>{currentUser.shinkansenSegmentCount ?? 0} / {(gameConfig.shinkansenMaxSegments ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxSegments) > 0 ? `${gameConfig.shinkansenMaxSegments} 区間` : '無制限'}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={async () => {
                        setIsProcessing(true);
                        try { await onIncrementShinkansenSegment?.(); }
                        finally { setIsProcessing(false); }
                      }}
                      disabled={isProcessing}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl active:scale-95 shadow transition-all"
                    >
                      +1区間
                    </button>
                    {onResetShinkansen && (Date.now() - currentUser.shinkansenStartTime <= 60_000 && (currentUser.shinkansenSegmentCount ?? 0) === 0) && (
                      <button
                        type="button"
                        onClick={async () => {
                          setIsProcessing(true);
                          try { await onResetShinkansen(); }
                          finally { setIsProcessing(false); }
                        }}
                        disabled={isProcessing}
                        className="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-bold rounded-xl active:scale-95 shadow transition-all"
                        title="新幹線乗車を取消（開始60秒以内のみ）"
                      >
                        取消(60秒以内)
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      setIsProcessing(true);
                      try { await onActivateInvincibility(); }
                      catch { toast.error('失敗しました'); }
                      finally { setIsProcessing(false); }
                    }}
                    disabled={
                      isProcessing || (currentUser.invincibleCards ?? 0) <= 0 || timeLeft.invincible > 0 || gameConfig.gameStatus.includes('_PAUSED')
                    }
                    className="px-4 py-3 bg-amber-500 text-white rounded-2xl font-bold text-sm shadow-xl disabled:bg-slate-100 disabled:text-slate-400 active:scale-95 transition-all"
                  >
                    無敵 ({currentUser.invincibleCards ?? 0})
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setIsProcessing(true);
                      try { await onStartShinkansenWait(); }
                      catch { toast.error('失敗しました'); }
                      finally { setIsProcessing(false); }
                    }}
                    disabled={isProcessing || currentUser.status !== 'ACTIVE'}
                    className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-2xl font-black text-sm shadow-xl active:scale-95 transition-all"
                  >
                    下車待機（{gameConfig.postShinkansenWaitMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.postShinkansenWaitMinutes}分）開始
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 w-full justify-center">
                <button
                  type="button"
                  onClick={async () => {
                    setIsProcessing(true);
                    try { await onActivateInvincibility(); }
                    catch { toast.error('失敗しました'); }
                    finally { setIsProcessing(false); }
                  }}
                  disabled={
                    isProcessing || (currentUser.invincibleCards ?? 0) <= 0 || timeLeft.invincible > 0 || gameConfig.gameStatus.includes('_PAUSED')
                  }
                  className="px-4 py-3 bg-amber-500 text-white rounded-2xl font-bold text-sm shadow-xl disabled:bg-slate-100 disabled:text-slate-400 active:scale-95 transition-all"
                >
                  無敵カード ({currentUser.invincibleCards ?? 0})
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setIsProcessing(true);
                    try { await onStartShinkansen?.(); }
                    finally { setIsProcessing(false); }
                  }}
                  disabled={isProcessing || currentUser.status !== 'ACTIVE' || !isGameActive(gameConfig.gameStatus)}
                  className="px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-bold text-sm shadow-xl disabled:bg-slate-100 disabled:text-slate-400 active:scale-95 transition-all flex items-center gap-1.5"
                >
                  <Train size={16} /> 新幹線乗車開始
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setIsProcessing(true);
                    try { await onStartShinkansenWait(); }
                    catch { toast.error('失敗しました'); }
                    finally { setIsProcessing(false); }
                  }}
                  disabled={isProcessing || currentUser.status !== 'ACTIVE' || !isGameActive(gameConfig.gameStatus) || timeLeft.shinkansenRemaining > 0}
                  className="px-4 py-3 bg-white text-slate-700 rounded-2xl font-bold text-sm shadow-xl border border-slate-200 disabled:bg-slate-50 active:scale-95 transition-all"
                >
                  待機
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MapView;

