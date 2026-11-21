import { useCallback, useEffect, useRef } from 'react';
import type { GameStatus } from '../../types';
import type { Coordinates, UpdatePrivateLocationResult } from '../application';
import { canUpdatePrivateLocation, isGameActive, shouldThrottleLocationUpdate } from '../game';

interface UseMapGeolocationParams {
  currentUserId: string;
  gameSessionId?: string;
  gameStatus: GameStatus;
  onLocalPosition?: (coords: Coordinates) => void;
  onPermissionError?: (error: GeolocationPositionError) => void;
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
  onLocalPosition,
  onPermissionError,
  onUpdatePrivateLocation,
}: UseMapGeolocationParams): void {
  const watchIdRef = useRef<number | null>(null);
  const lastUploadTimeRef = useRef<number>(0);
  const lastUploadedCoordsRef = useRef<Coordinates | null>(null);
  const permissionErrorNotifiedRef = useRef<boolean>(false);
  const onLocalPositionRef = useRef(onLocalPosition);
  const onPermissionErrorRef = useRef(onPermissionError);
  const isTrackingEnabled = Boolean(currentUserId && isGameActive(gameStatus));

  useEffect(() => {
    onLocalPositionRef.current = onLocalPosition;
  }, [onLocalPosition]);

  useEffect(() => {
    onPermissionErrorRef.current = onPermissionError;
  }, [onPermissionError]);

  const updateLocation = useCallback(async (position: GeolocationPosition) => {
    if (!currentUserId || !canUpdatePrivateLocation(gameStatus)) return;
    const { latitude, longitude, accuracy } = position.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const currentCoords: Coordinates = { latitude, longitude };
    if (!Number.isFinite(accuracy) || accuracy <= 400) {
      onLocalPositionRef.current?.(currentCoords);
    }

    if (!gameSessionId || !navigator.onLine) return;

    const now = Date.now();
    const decision = shouldThrottleLocationUpdate({
      currentCoords,
      currentAccuracy: accuracy,
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
    if (!isTrackingEnabled || !('geolocation' in navigator)) return;

    const startWatching = () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      watchIdRef.current = navigator.geolocation.watchPosition(
        position => {
          permissionErrorNotifiedRef.current = false;
          void updateLocationRef.current(position);
        },
        error => {
          console.error('Geolocation watch error:', error);
          if (error.code === 1 && !permissionErrorNotifiedRef.current) {
            permissionErrorNotifiedRef.current = true;
            onPermissionErrorRef.current?.(error);
          }
        },
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

    const handleResumeWatch = () => {
      if (document.visibilityState === 'visible' && watchIdRef.current === null) {
        startWatching();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handleResumeWatch);
    window.addEventListener('online', handleResumeWatch);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handleResumeWatch);
      window.removeEventListener('online', handleResumeWatch);
      stopWatching();
    };
  }, [isTrackingEnabled]);
}
