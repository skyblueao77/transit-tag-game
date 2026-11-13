import { useEffect } from 'react';
import type { ExposedLocation, GameConfig, PrivateLocation, User } from '../../types';
import { resolveAutoExposePlan } from '../game';
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
 * 管理者による全体公開、チーム別公開、またはペナルティ公開を検知した場合に
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
    privateLocation,
    exposedLocations,
  ]);
}
