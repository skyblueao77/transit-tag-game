import { useCallback, useEffect, useRef } from 'react';
import type { GameStatus } from '../../types';
import type { Coordinates, UpdatePrivateLocationResult } from '../application';
import { canUpdatePrivateLocation, shouldThrottleLocationUpdate } from '../game';

interface UseMapGeolocationParams {
  currentUserId: string;
  gameSessionId?: string;
  gameStatus: GameStatus;
  onUpdatePrivateLocation: (
    input: Coordinates & { playerId: string; expectedSessionId: string },
  ) => Promise<UpdatePrivateLocationResult>;
}

/**
 * プレイヤーの現在地をwatchPositionで監視し、移動距離・時間スロットルと
 * Page Visibility に応じて Private Location を更新するフック。
 */
export default function useMapGeolocation({
  currentUserId,
  gameSessionId,
  gameStatus,
  onUpdatePrivateLocation,
}: UseMapGeolocationParams): void {
  const watchIdRef = useRef<number | null>(null);
  const lastUploadTimeRef = useRef<number>(0);
  const lastUploadedCoordsRef = useRef<Coordinates | null>(null);

  const updateLocation = useCallback(async (position: GeolocationPosition) => {
    if (!currentUserId || !gameSessionId || !canUpdatePrivateLocation(gameStatus)) return;
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
      lastUploadedCoords: lastUploadedCoordsRef.current,
      lastUploadedTimeMs: lastUploadTimeRef.current,
    });

    if (!decision.shouldUpload) return;

    try {
      const result = await onUpdatePrivateLocation({
        playerId: currentUserId,
        expectedSessionId: gameSessionId,
        latitude: currentCoords.latitude,
        longitude: currentCoords.longitude,
      });
      if (!result.ok) {
        console.error('Failed to update private location:', result.reason);
        return;
      }
      lastUploadTimeRef.current = now;
      lastUploadedCoordsRef.current = currentCoords;
    } catch (error) {
      console.error('Failed to update location:', error);
    }
  }, [currentUserId, gameStatus, gameSessionId, onUpdatePrivateLocation]);

  const updateLocationRef = useRef(updateLocation);
  useEffect(() => {
    updateLocationRef.current = updateLocation;
  }, [updateLocation]);

  useEffect(() => {
    if (!currentUserId || !('geolocation' in navigator)) return;

    const startWatching = () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      watchIdRef.current = navigator.geolocation.watchPosition(
        position => {
          void updateLocationRef.current(position);
        },
        error => console.error('Geolocation watch error:', error),
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 },
      );
    };

    const stopWatching = () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
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
  }, [currentUserId]);
}
