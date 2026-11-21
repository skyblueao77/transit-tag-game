import type React from 'react';
import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { LocateFixed, Minus, Plus } from 'lucide-react';
import type { User, PrivateLocation, ExposedLocation, GameConfig, Role, ProtectionZoneType } from '../types';
import type { Coordinates } from '../src/application';
import {
  analyzeTransitSuggestions,
  computeTeammateSplitMetrics,
  getPlayerRole,
  isActiveUntil,
  isGameActive,
  remainingSeconds,
  resolveLocationVisibility,
  type StationData,
  type TransitSuggestion,
} from '../src/game';
import L from '../src/lib/leafletSetup';
import { getCachedStations, loadStations } from '../src/lib/stationsLoader';
import { createPlayerMapPopup, type PlayerMapPopupVariant } from './playerMapPopup';
import useWakeLock from '../src/hooks/useWakeLock';
import useOnlineStatus from '../src/hooks/useOnlineStatus';
import useMapTimers from '../src/hooks/useMapTimers';
import { toast } from 'sonner';
import StationSuggestCard from '../src/components/StationSuggestCard';
import OniWaitingOverlay from './map/OniWaitingOverlay';
import MapStatusHeader from './map/MapStatusHeader';
import MapStatusBadges from './map/MapStatusBadges';
import MapOniCapturePanel from './map/MapOniCapturePanel';
import MapRunnerControls from './map/MapRunnerControls';

const AUTO_STATION_UPDATE_COOLDOWN_MS = 10 * 60 * 1000;

function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return '無制限';
  const clamped = Math.max(0, sec);
  const m = Math.floor(clamped / 60);
  const s = Math.floor(clamped % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Props {
  users: User[];
  currentUser: User;
  privateLocation: PrivateLocation | null;
  exposedLocations: Record<string, ExposedLocation>;
  gameConfig: GameConfig;
  onCapture: (runnerId: string) => Promise<void>;
  onActivateInvincibility: () => Promise<void>;
  onStartShinkansenWait: () => Promise<void>;
  onUpdateLastStation?: (stationName: string, options?: { silentToast?: boolean }) => Promise<void>;
  onUpdateProtectionZone?: (zone: ProtectionZoneType) => Promise<void>;
  onStartShinkansen?: () => Promise<void>;
  onIncrementShinkansenSegment?: () => Promise<void>;
  onResetShinkansen?: () => Promise<void>;
}

const MapView: React.FC<Props> = ({
  users,
  currentUser,
  privateLocation,
  exposedLocations,
  gameConfig,
  onCapture,
  onActivateInvincibility,
  onStartShinkansenWait,
  onUpdateLastStation,
  onUpdateProtectionZone,
  onStartShinkansen,
  onIncrementShinkansenSegment,
  onResetShinkansen,
}) => {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<Record<string, L.CircleMarker>>({});
  const hasInitialCenteredRef = useRef(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const isOnline = useOnlineStatus();

  const [stations, setStations] = useState<StationData[]>(() => getCachedStations() ?? []);
  const [transitSuggestion, setTransitSuggestion] = useState<TransitSuggestion | null>(null);
  const [transitCandidates, setTransitCandidates] = useState<TransitSuggestion[]>([]);
  const [isSuggestDismissed, setIsSuggestDismissed] = useState(false);
  const [locationFixSeq, setLocationFixSeq] = useState(0);
  const lastDismissedKey = useRef<string | null>(null);
  const prevCoordsRef = useRef<Coordinates | null>(null);

  const [isAutoUpdateEnabled, setIsAutoUpdateEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('transit_auto_update_enabled') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (stations.length > 0) return;
    let active = true;
    loadStations()
      .then(loaded => {
        if (active) setStations(loaded);
      })
      .catch(error => {
        console.error('Failed to load station data:', error);
      });
    return () => {
      active = false;
    };
  }, [stations.length]);

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
    if (stations.length === 0) {
      return;
    }
    const currentCoords: Coordinates = {
      latitude: privateLocation.latitude,
      longitude: privateLocation.longitude,
    };
    const previousCoords = prevCoordsRef.current;

    const { primary: suggestion, candidates } = analyzeTransitSuggestions(currentCoords, stations, {
      previousCoords,
    });

    prevCoordsRef.current = currentCoords;
    setTransitCandidates(candidates);
    setTransitSuggestion(suggestion);
    setLocationFixSeq(seq => seq + 1);

    if (suggestion && suggestion.displayText !== lastDismissedKey.current) {
      setIsSuggestDismissed(false);
    }
  }, [privateLocation, stations]);

  // 自動反映（オートチェックイン）ロジック（異なる測位フィックス2回連続かつ最小10分間隔）
  const stableSuggestionRef = useRef<{ text: string; count: number }>({ text: '', count: 0 });
  const lastAutoUpdatedKey = useRef<string | null>(null);
  const lastEvaluatedFixSeqRef = useRef<number>(0);
  const lastAutoUpdateAtRef = useRef<number>(0);
  const isAutoUpdatingRef = useRef(false);

  useEffect(() => {
    if (
      !isOnline
      || !isAutoUpdateEnabled
      || !transitSuggestion
      || !onUpdateLastStation
      || currentUser.status === 'RETIRED'
    ) {
      stableSuggestionRef.current = { text: '', count: 0 };
      return;
    }
    if (isAutoUpdatingRef.current) {
      return;
    }
    if (locationFixSeq === 0 || locationFixSeq === lastEvaluatedFixSeqRef.current) {
      return;
    }
    lastEvaluatedFixSeqRef.current = locationFixSeq;

    const currentTarget = transitSuggestion.displayText;
    if (currentUser.lastStation === currentTarget || lastAutoUpdatedKey.current === currentTarget) {
      stableSuggestionRef.current = { text: currentTarget, count: 0 };
      return;
    }

    if (stableSuggestionRef.current.text === currentTarget) {
      stableSuggestionRef.current.count += 1;
    } else {
      stableSuggestionRef.current = { text: currentTarget, count: 1 };
    }

    if (stableSuggestionRef.current.count >= 2) {
      const nowMs = Date.now();
      if (lastAutoUpdateAtRef.current > 0 && nowMs - lastAutoUpdateAtRef.current < AUTO_STATION_UPDATE_COOLDOWN_MS) {
        return;
      }
      isAutoUpdatingRef.current = true;
      onUpdateLastStation(currentTarget, { silentToast: true })
        .then(() => {
          lastAutoUpdatedKey.current = currentTarget;
          lastAutoUpdateAtRef.current = Date.now();
          stableSuggestionRef.current = { text: currentTarget, count: 0 };
          toast.success(`現在地を自動更新しました: ${currentTarget}`, {
            duration: 3500,
          });
        })
        .catch(err => {
          console.error('Failed to auto update station:', err);
          stableSuggestionRef.current = { text: currentTarget, count: 0 };
        })
        .finally(() => {
          isAutoUpdatingRef.current = false;
        });
    }
  }, [isOnline, transitSuggestion, locationFixSeq, isAutoUpdateEnabled, currentUser.lastStation, currentUser.status, onUpdateLastStation]);

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

  useWakeLock(isGameActive(gameConfig.gameStatus));

  const isAdminViewer = currentUser.team === 'ADMIN';
  const currentRole: Role = getPlayerRole(currentUser, gameConfig);
  const { timeLeft, nowMs } = useMapTimers(currentUser, gameConfig, currentRole);
  const isOniLocked = !isAdminViewer && timeLeft.oniLock > 0;
  const epoch5sMs = Math.floor(nowMs / 5000) * 5000;

  const captureCandidates = useMemo(
    () => (
      !isAdminViewer && currentRole === 'ONI'
        ? users.filter(user => (
          user.id !== currentUser.id &&
          user.status === 'ACTIVE' &&
          getPlayerRole(user, gameConfig) === 'RUNNER' &&
          !isActiveUntil(user.invincibleUntil, epoch5sMs)
        ))
        : []
    ),
    [isAdminViewer, currentRole, users, currentUser.id, gameConfig, epoch5sMs],
  );

  useEffect(() => {
    if (!captureCandidates.some(user => user.id === selectedTargetId)) {
      setSelectedTargetId(captureCandidates[0]?.id ?? '');
    }
  }, [captureCandidates, selectedTargetId]);

  // チーム同一行動の距離判定（期限切れのスナップショットは除外）
  const { maxTeammateDistance, isTeamSplitAlert } = useMemo(
    () => (isAdminViewer
      ? { maxTeammateDistance: 0, isTeamSplitAlert: false }
      : computeTeammateSplitMetrics({
          currentUserId: currentUser.id,
          currentUserTeam: currentUser.team,
          myCoords: privateLocation
            ? { latitude: privateLocation.latitude, longitude: privateLocation.longitude }
            : null,
          users,
          exposedLocations,
          nowMs: epoch5sMs,
        })),
    [isAdminViewer, privateLocation, currentUser.id, currentUser.team, users, exposedLocations, epoch5sMs],
  );

  // 地図初期化（GPS更新や毎秒カウントダウンのたびに破棄・再生成しないよう isOniLocked のみに依存）
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial map coordinates only, not recreated on GPS updates
  useEffect(() => {
    if (!containerRef.current || isOniLocked) return;
    if (!mapRef.current) {
      const hasInitialCoords = Boolean(privateLocation);
      const map = L.map(containerRef.current, {
        zoomControl: false,
        zoomAnimation: false,
        markerZoomAnimation: false,
      }).setView(
        [privateLocation?.latitude ?? 35.6812, privateLocation?.longitude ?? 139.7671],
        hasInitialCoords ? 14 : 13,
      );
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>',
        crossOrigin: true,
        maxZoom: 18,
      }).addTo(map);
      mapRef.current = map;
      hasInitialCenteredRef.current = hasInitialCoords;
    }

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current && mapRef.current) {
      const currentMap = mapRef.current;
      resizeObserver = new ResizeObserver(() => {
        if (mapRef.current === currentMap) {
          currentMap.invalidateSize({ pan: false });
        }
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver?.disconnect();
      markersRef.current = {};
      hasInitialCenteredRef.current = false;
      if (mapRef.current) {
        mapRef.current.stop();
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [isOniLocked]);

  // 初回現在地取得時の自動パン
  useEffect(() => {
    const map = mapRef.current;
    if (!map || isOniLocked || !privateLocation || hasInitialCenteredRef.current) return;
    map.setView([privateLocation.latitude, privateLocation.longitude], Math.max(map.getZoom(), 14), { animate: false });
    hasInitialCenteredRef.current = true;
  }, [privateLocation, isOniLocked]);

  const handleRecenterMap = useCallback(() => {
    const map = mapRef.current;
    if (!map || !privateLocation) {
      toast.info('現在地を取得中です。GPSが有効か確認してください。');
      return;
    }
    map.setView([privateLocation.latitude, privateLocation.longitude], Math.max(map.getZoom(), 15), {
      animate: false,
    });
  }, [privateLocation]);

  // マーカー描画（強制共有・チーム別サーチ対応版：差分更新）
  useEffect(() => {
    const currentMap = mapRef.current;
    if (!currentMap || isOniLocked) return;

    const now = epoch5sMs;
    const visibleIds = new Set<string>();

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
        startTime: gameConfig.startTime,
        periodicRevealIntervalMinutes: gameConfig.periodicRevealIntervalMinutes,
        periodicRevealDurationMinutes: gameConfig.periodicRevealDurationMinutes,
      });

      if (visibility.mode === 'HIDDEN' || visibility.latitude === undefined || visibility.longitude === undefined) return;

      visibleIds.add(user.id);

      const isSelf = visibility.mode === 'SELF_PRIVATE';
      const isTeamSearchActive = visibility.mode === 'TEAM_SNAPSHOT';
      const isGlobalForceReveal = visibility.mode === 'GLOBAL_SNAPSHOT';
      const isPenaltyActive = visibility.mode === 'PENALTY_SNAPSHOT';
      const isInvincible = isActiveUntil(user.invincibleUntil, now);

      const latLng: [number, number] = [visibility.latitude, visibility.longitude];
      const markerStyle: L.CircleMarkerOptions = {
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
      };

      let popupVariant: PlayerMapPopupVariant;
      let remainingTime: string | undefined;
      if (isSelf) {
        popupVariant = 'SELF';
      } else if (isPenaltyActive) {
        popupVariant = 'PENALTY';
        remainingTime = formatTime(remainingSeconds(visibility.expiresAt, now));
      } else if (isTeamSearchActive) {
        popupVariant = 'TEAM_SEARCH';
      } else if (isGlobalForceReveal) {
        popupVariant = 'GLOBAL_REVEAL';
      } else {
        popupVariant = 'EXPOSED';
        remainingTime = formatTime(remainingSeconds(visibility.expiresAt, now));
      }

      const popupContent = createPlayerMapPopup(document, user, popupVariant, remainingTime);
      const existingMarker = markersRef.current[user.id];

      if (existingMarker) {
        existingMarker.setLatLng(latLng);
        existingMarker.setStyle(markerStyle);
        if (existingMarker.getPopup()) {
          existingMarker.setPopupContent(popupContent);
        } else {
          existingMarker.bindPopup(popupContent);
        }
      } else {
        const marker = L.circleMarker(latLng, markerStyle).addTo(currentMap);
        marker.bindPopup(popupContent);
        markersRef.current[user.id] = marker;
      }
    });

    Object.entries(markersRef.current).forEach(([id, marker]) => {
      if (!visibleIds.has(id)) {
        marker.remove();
        delete markersRef.current[id];
      }
    });
  }, [
    isOniLocked,
    users,
    currentUser,
    privateLocation,
    exposedLocations,
    gameConfig.locationRevealUntil,
    gameConfig.teamARevealUntil,
    gameConfig.teamBRevealUntil,
    gameConfig.startTime,
    gameConfig.periodicRevealIntervalMinutes,
    gameConfig.periodicRevealDurationMinutes,
    gameConfig.gameStatus,
    epoch5sMs,
  ]);

  if (isOniLocked) {
    return <OniWaitingOverlay remainingSeconds={timeLeft.oniLock} formatTime={formatTime} />;
  }

  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      {/* オフライン通知は App.tsx 側の統合バナーで表示する */}
      <MapStatusHeader
        isOffline={false}
        timeLeft={timeLeft}
        gameConfig={gameConfig}
        isTeamSplitAlert={isTeamSplitAlert}
        maxTeammateDistance={maxTeammateDistance}
        formatTime={formatTime}
      />

      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="relative isolate z-0 h-full w-full" />

        {/* 地図上部オーバーレイHUD（ステータスバッジ・現在地ボタン・ズームボタン・駅提案カードの重なりを防止） */}
        <div className="pointer-events-none absolute top-3 inset-x-3 z-[1001] flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0 flex flex-col items-start gap-1.5">
            {!isAdminViewer && (
              <MapStatusBadges currentUser={currentUser} timeLeft={timeLeft} formatTime={formatTime} />
            )}
            {!isAdminViewer && !isSuggestDismissed && transitSuggestion && onUpdateLastStation && (
              <div className="w-full max-w-sm">
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
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <button
              type="button"
              onClick={handleRecenterMap}
              aria-label="現在地へ戻る"
              title="現在地へ戻る"
              className="pointer-events-auto w-10 h-10 rounded-xl bg-white/95 hover:bg-white text-slate-800 shadow-lg border border-slate-200 flex items-center justify-center active:scale-95 transition-all"
            >
              <LocateFixed size={18} className={privateLocation ? 'text-blue-600' : 'text-slate-400'} />
            </button>
            <div className="pointer-events-auto flex flex-col rounded-xl bg-white/95 shadow-lg border border-slate-200 overflow-hidden">
              <button
                type="button"
                onClick={() => mapRef.current?.zoomIn()}
                aria-label="地図を拡大"
                title="地図を拡大"
                className="w-10 h-10 flex items-center justify-center text-slate-800 hover:bg-slate-50 active:scale-95 transition-all border-b border-slate-200"
              >
                <Plus size={18} />
              </button>
              <button
                type="button"
                onClick={() => mapRef.current?.zoomOut()}
                aria-label="地図を縮小"
                title="地図を縮小"
                className="w-10 h-10 flex items-center justify-center text-slate-800 hover:bg-slate-50 active:scale-95 transition-all"
              >
                <Minus size={18} />
              </button>
            </div>
          </div>
        </div>

        {isAdminViewer ? (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1000] px-4 py-2 rounded-full bg-slate-900/90 text-white text-xs font-bold shadow-lg pointer-events-none">
            管理者プレビュー（閲覧専用）
          </div>
        ) : (
          <div className="absolute bottom-3 sm:bottom-6 left-1/2 -translate-x-1/2 z-[1000] w-full px-3 sm:px-6 flex flex-col items-center gap-3 pointer-events-none [&>*]:pointer-events-auto">
            {currentRole === 'ONI' && (
              <MapOniCapturePanel
                currentUser={currentUser}
                gameConfig={gameConfig}
                captureCandidates={captureCandidates}
                selectedTargetId={selectedTargetId}
                isProcessing={isProcessing}
                onSelectTarget={setSelectedTargetId}
                onCapture={async targetId => {
                  setIsProcessing(true);
                  try {
                    await onCapture(targetId);
                  } finally {
                    setIsProcessing(false);
                  }
                }}
              />
            )}
            {currentRole === 'RUNNER' && (
              <MapRunnerControls
                currentUser={currentUser}
                gameConfig={gameConfig}
                timeLeft={timeLeft}
                nowMs={nowMs}
                isProcessing={isProcessing}
                setIsProcessing={setIsProcessing}
                formatTime={formatTime}
                onActivateInvincibility={onActivateInvincibility}
                onStartShinkansenWait={onStartShinkansenWait}
                onUpdateProtectionZone={onUpdateProtectionZone}
                onStartShinkansen={onStartShinkansen}
                onIncrementShinkansenSegment={onIncrementShinkansenSegment}
                onResetShinkansen={onResetShinkansen}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MapView;
