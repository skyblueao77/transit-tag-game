import type React from 'react';
import { useEffect, useRef, useState, useMemo } from 'react';
import type { User, PrivateLocation, ExposedLocation, GameConfig, Role, ProtectionZoneType } from '../types';
import type { Coordinates, UpdatePrivateLocationResult } from '../src/application';
import {
  computeTeammateSplitMetrics,
  findCandidateTransitSuggestions,
  findTransitSuggestion,
  getPlayerRole,
  isActiveUntil,
  remainingSeconds,
  resolveLocationVisibility,
  type StationData,
  type TransitSuggestion,
} from '../src/game';
import L from '../src/lib/leafletSetup';
import { createPlayerMapPopup, type PlayerMapPopupVariant } from './playerMapPopup';
import useWakeLock from '../src/hooks/useWakeLock';
import useOnlineStatus from '../src/hooks/useOnlineStatus';
import useMapTimers from '../src/hooks/useMapTimers';
import useMapGeolocation from '../src/hooks/useMapGeolocation';
import { toast } from 'sonner';
import stationsData from '../src/data/stations.json';
import StationSuggestCard from '../src/components/StationSuggestCard';
import OniWaitingOverlay from './map/OniWaitingOverlay';
import MapStatusHeader from './map/MapStatusHeader';
import MapStatusBadges from './map/MapStatusBadges';
import MapOniCapturePanel from './map/MapOniCapturePanel';
import MapRunnerControls from './map/MapRunnerControls';

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Props {
  users: User[];
  currentUser: User;
  privateLocation: PrivateLocation | null;
  exposedLocations: Record<string, ExposedLocation>;
  gameConfig: GameConfig;
  onUpdatePrivateLocation: (input: Coordinates & { playerId: string; expectedSessionId: string }) => Promise<UpdatePrivateLocationResult>;
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
  onUpdatePrivateLocation,
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
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const isOnline = useOnlineStatus();
  const isOffline = !isOnline;

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

  // 自動反映（オートチェックイン）ロジック
  const stableSuggestionRef = useRef<{ text: string; count: number }>({ text: '', count: 0 });
  const lastAutoUpdatedKey = useRef<string | null>(null);
  const isAutoUpdatingRef = useRef(false);

  useEffect(() => {
    if (!isOnline || !isAutoUpdateEnabled || !transitSuggestion || !onUpdateLastStation || isAutoUpdatingRef.current) {
      return;
    }

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
      isAutoUpdatingRef.current = true;
      onUpdateLastStation(currentTarget, { silentToast: true })
        .then(() => {
          lastAutoUpdatedKey.current = currentTarget;
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
  }, [isOnline, transitSuggestion, isAutoUpdateEnabled, currentUser.lastStation, onUpdateLastStation]);

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

  useWakeLock(true);

  useMapGeolocation({
    currentUserId: currentUser.id,
    gameSessionId: gameConfig.gameSessionId,
    gameStatus: gameConfig.gameStatus,
    onUpdatePrivateLocation,
  });

  const currentRole: Role = getPlayerRole(currentUser, gameConfig);
  const { timeLeft, nowMs } = useMapTimers(currentUser, gameConfig, currentRole);
  const isOniLocked = timeLeft.oniLock > 0;
  const epoch5sMs = Math.floor(nowMs / 5000) * 5000;

  const captureCandidates = useMemo(
    () => (
      currentRole === 'ONI'
        ? users.filter(user => (
          user.id !== currentUser.id &&
          user.status === 'ACTIVE' &&
          getPlayerRole(user, gameConfig) === 'RUNNER' &&
          !isActiveUntil(user.invincibleUntil, epoch5sMs)
        ))
        : []
    ),
    [currentRole, users, currentUser.id, gameConfig, epoch5sMs],
  );

  useEffect(() => {
    if (!captureCandidates.some(user => user.id === selectedTargetId)) {
      setSelectedTargetId(captureCandidates[0]?.id ?? '');
    }
  }, [captureCandidates, selectedTargetId]);

  // チーム同一行動の距離判定（期限切れのスナップショットは除外）
  const { maxTeammateDistance, isTeamSplitAlert } = useMemo(
    () => computeTeammateSplitMetrics({
      currentUserId: currentUser.id,
      currentUserTeam: currentUser.team,
      myCoords: privateLocation
        ? { latitude: privateLocation.latitude, longitude: privateLocation.longitude }
        : null,
      users,
      exposedLocations,
      nowMs: epoch5sMs,
    }),
    [privateLocation, currentUser.id, currentUser.team, users, exposedLocations, epoch5sMs],
  );

  // 地図初期化（GPS更新や毎秒カウントダウンのたびに破棄・再生成しないよう isOniLocked のみに依存）
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial map coordinates only, not recreated on GPS updates
  useEffect(() => {
    if (!containerRef.current || isOniLocked) return;
    if (!mapRef.current) {
      const map = L.map(containerRef.current).setView(
        [privateLocation?.latitude ?? 35.6812, privateLocation?.longitude ?? 139.7671], 13,
      );
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
      mapRef.current = map;
    }

    return () => {
      markersRef.current = {};
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [isOniLocked]);

  // マーカー描画（強制共有・チーム別サーチ対応版：差分更新）
  useEffect(() => {
    const currentMap = mapRef.current;
    if (!currentMap || isOniLocked) return;

    const now = Date.now();
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
    gameConfig.gameStatus,
  ]);

  if (isOniLocked) {
    return <OniWaitingOverlay remainingSeconds={timeLeft.oniLock} formatTime={formatTime} />;
  }

  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      <MapStatusHeader
        isOffline={isOffline}
        timeLeft={timeLeft}
        gameConfig={gameConfig}
        isTeamSplitAlert={isTeamSplitAlert}
        maxTeammateDistance={maxTeammateDistance}
        formatTime={formatTime}
      />

      <div ref={containerRef} style={{ flex: 1, width: '100%', zIndex: 0 }} />

      {!isSuggestDismissed && transitSuggestion && onUpdateLastStation && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[1001] w-full px-4 max-w-sm sm:max-w-md pointer-events-none">
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

      <MapStatusBadges currentUser={currentUser} timeLeft={timeLeft} formatTime={formatTime} />

      <div className="absolute bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-[1000] w-full px-4 sm:px-6 flex flex-col items-center gap-3 pointer-events-none [&>*]:pointer-events-auto">
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
    </div>
  );
};

export default MapView;
