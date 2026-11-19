import { useEffect, useState } from 'react';
import type { ExposedLocation, GameConfig, PrivateLocation, User } from '../../types';
import { canRevealLocation, resolveAutoExposePlan, resolvePeriodicRevealWindow } from '../game';
import { exposeLocation } from '../application';
import { firebaseExposedLocationStore } from '../infrastructure/firebase/locationStores';
import { getServerNowMs } from '../infrastructure/firebase/serverClock';

interface UsePlayerAutoExposeParams {
  isOnline: boolean;
  currentUser: User | null;
  isAdmin: boolean;
  gameConfig: GameConfig;
  privateLocation: PrivateLocation | null;
  exposedLocations: Record<string, ExposedLocation>;
}

/**
 * 管理者による全体公開、定期公開、チーム別公開、またはペナルティ公開を検知した場合に
 * 自己のPrivate位置情報をスナップショットとして自動投影するフック。
 */
export default function usePlayerAutoExpose({
  isOnline,
  currentUser,
  isAdmin,
  gameConfig,
  privateLocation,
  exposedLocations,
}: UsePlayerAutoExposeParams): void {
  const [windowTick, setWindowTick] = useState(0);

  useEffect(() => {
    if (
      !isOnline
      || isAdmin
      || !currentUser
      || currentUser.status === 'EMERGENCY'
      || currentUser.status === 'RETIRED'
      || !canRevealLocation(gameConfig.gameStatus)
      || !gameConfig.startTime
    ) {
      return;
    }

    const now = getServerNowMs();
    const periodicWindow = resolvePeriodicRevealWindow({
      phase: gameConfig.gameStatus,
      now,
      startTime: gameConfig.startTime,
      intervalMinutes: gameConfig.periodicRevealIntervalMinutes,
      durationMinutes: gameConfig.periodicRevealDurationMinutes,
    });
    const nextCheckMs = periodicWindow.isActive && periodicWindow.activeUntil !== undefined
      ? Math.min(60_000, Math.max(1000, periodicWindow.activeUntil - now + 250))
      : periodicWindow.nextWindowStart !== undefined
        ? Math.min(60_000, Math.max(1000, periodicWindow.nextWindowStart - now + 250))
        : 60_000;

    const timer = window.setTimeout(() => {
      setWindowTick(tick => tick + 1);
    }, nextCheckMs);
    return () => window.clearTimeout(timer);
  }, [
    isOnline,
    isAdmin,
    currentUser,
    gameConfig.gameStatus,
    gameConfig.startTime,
    gameConfig.periodicRevealIntervalMinutes,
    gameConfig.periodicRevealDurationMinutes,
    windowTick,
  ]);

  useEffect(() => {
    const now = getServerNowMs();
    const existing = currentUser ? exposedLocations[currentUser.id] : undefined;
    const plan = resolveAutoExposePlan({
      isOnline,
      isAdmin,
      now,
      currentUser,
      gameConfig: {
        gameSessionId: gameConfig.gameSessionId,
        gameStatus: gameConfig.gameStatus,
        locationRevealUntil: gameConfig.locationRevealUntil,
        teamARevealUntil: gameConfig.teamARevealUntil,
        teamBRevealUntil: gameConfig.teamBRevealUntil,
        startTime: gameConfig.startTime,
        periodicRevealIntervalMinutes: gameConfig.periodicRevealIntervalMinutes,
        periodicRevealDurationMinutes: gameConfig.periodicRevealDurationMinutes,
      },
      privateLocation,
      existingExposedLocation: existing,
    });
    if (!plan || !currentUser || !gameConfig.gameSessionId || !privateLocation) return;

    void exposeLocation({
      playerId: currentUser.id,
      expectedSessionId: gameConfig.gameSessionId,
      privateLocation,
      phase: gameConfig.gameStatus,
      now,
      duration: plan.duration,
      revealScope: plan.revealScope,
    }, firebaseExposedLocationStore);
  }, [
    isOnline,
    currentUser,
    isAdmin,
    gameConfig.gameSessionId,
    gameConfig.gameStatus,
    gameConfig.locationRevealUntil,
    gameConfig.teamARevealUntil,
    gameConfig.teamBRevealUntil,
    gameConfig.startTime,
    gameConfig.periodicRevealIntervalMinutes,
    gameConfig.periodicRevealDurationMinutes,
    privateLocation,
    exposedLocations,
    windowTick,
  ]);
}
