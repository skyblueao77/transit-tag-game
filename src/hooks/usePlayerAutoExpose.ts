import { useEffect } from 'react';
import type { ExposedLocation, GameConfig, PrivateLocation, User } from '../../types';
import { canRevealLocation } from '../game';
import { exposeLocation } from '../application';
import { firebaseExposedLocationStore } from '../infrastructure/firebase/locationStores';

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
    if (!isOnline || !currentUser || isAdmin || !gameConfig.gameSessionId) return;
    if (currentUser.status === 'EMERGENCY' || currentUser.status === 'RETIRED') return;
    if (!canRevealLocation(gameConfig.gameStatus)) return;
    if (!privateLocation || privateLocation.gameSessionId !== gameConfig.gameSessionId) return;

    const now = Date.now();
    let activeScope: 'PENALTY' | 'GLOBAL' | 'TEAM_A' | 'TEAM_B' | null = null;
    let targetUntil = 0;

    const penaltyUntil = typeof currentUser.penaltyRevealUntil === 'number' ? currentUser.penaltyRevealUntil : 0;
    const globalUntil = typeof gameConfig.locationRevealUntil === 'number' ? gameConfig.locationRevealUntil : 0;
    const teamAUntil = typeof gameConfig.teamARevealUntil === 'number' ? gameConfig.teamARevealUntil : 0;
    const teamBUntil = typeof gameConfig.teamBRevealUntil === 'number' ? gameConfig.teamBRevealUntil : 0;

    if (penaltyUntil > now) {
      activeScope = 'PENALTY';
      targetUntil = penaltyUntil;
    } else if (globalUntil > now) {
      activeScope = 'GLOBAL';
      targetUntil = globalUntil;
    } else if (currentUser.team === 'A' && teamAUntil > now) {
      activeScope = 'TEAM_A';
      targetUntil = teamAUntil;
    } else if (currentUser.team === 'B' && teamBUntil > now) {
      activeScope = 'TEAM_B';
      targetUntil = teamBUntil;
    }

    if (!activeScope || targetUntil <= now) return;

    const maxDurationMs = 60 * 60 * 1000;
    const duration = Math.min(targetUntil - now, maxDurationMs);
    if (duration <= 0) return;

    const existing = exposedLocations[currentUser.id];
    if (
      existing
      && existing.gameSessionId === gameConfig.gameSessionId
      && existing.revealScope === activeScope
    ) {
      const remainingValidMs = existing.expiresAt - now;
      const isExpiresAligned =
        Math.abs(existing.expiresAt - targetUntil) < 5000 ||
        (targetUntil - now > maxDurationMs && remainingValidMs > 30 * 60 * 1000);

      const hasMoved =
        activeScope === 'PENALTY' && (
          Math.abs(existing.latitude - privateLocation.latitude) > 0.0001 ||
          Math.abs(existing.longitude - privateLocation.longitude) > 0.0001
        );

      if (isExpiresAligned && !hasMoved) {
        return;
      }
    }

    void exposeLocation({
      playerId: currentUser.id,
      expectedSessionId: gameConfig.gameSessionId,
      privateLocation,
      phase: gameConfig.gameStatus,
      now,
      duration,
      revealScope: activeScope,
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
