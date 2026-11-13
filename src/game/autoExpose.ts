import { canRevealLocation } from './phases.ts';
import type { GameStatus } from './types';

export type AutoExposeScope = 'PENALTY' | 'GLOBAL' | 'TEAM_A' | 'TEAM_B';

export interface AutoExposeUserInput {
  id: string;
  team: string;
  status: string;
  penaltyRevealUntil?: number;
}

export interface AutoExposeConfigInput {
  gameSessionId?: string;
  gameStatus: GameStatus;
  locationRevealUntil?: number | null;
  teamARevealUntil?: number | null;
  teamBRevealUntil?: number | null;
}

export interface AutoExposePrivateLocationInput {
  gameSessionId: string;
  latitude: number;
  longitude: number;
}

export interface AutoExposeExistingSnapshotInput {
  gameSessionId: string;
  revealScope?: string;
  expiresAt: number;
  latitude: number;
  longitude: number;
}

export interface ResolveAutoExposePlanInput {
  isOnline: boolean;
  isAdmin: boolean;
  now: number;
  currentUser: AutoExposeUserInput | null;
  gameConfig: AutoExposeConfigInput;
  privateLocation: AutoExposePrivateLocationInput | null;
  existingExposedLocation?: AutoExposeExistingSnapshotInput | null;
}

export interface AutoExposePlan {
  revealScope: AutoExposeScope;
  duration: number;
  targetUntil: number;
}

export const AUTO_EXPOSE_MAX_DURATION_MS = 58 * 60 * 1000;

export function resolveAutoExposePlan({
  isOnline,
  isAdmin,
  now,
  currentUser,
  gameConfig,
  privateLocation,
  existingExposedLocation,
}: ResolveAutoExposePlanInput): AutoExposePlan | null {
  if (!isOnline || !currentUser || isAdmin || !gameConfig.gameSessionId) return null;
  if (currentUser.status === 'EMERGENCY' || currentUser.status === 'RETIRED') return null;
  if (!canRevealLocation(gameConfig.gameStatus)) return null;
  if (!privateLocation || privateLocation.gameSessionId !== gameConfig.gameSessionId) return null;

  let activeScope: AutoExposeScope | null = null;
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

  if (!activeScope || targetUntil <= now) return null;

  const duration = Math.min(targetUntil - now, AUTO_EXPOSE_MAX_DURATION_MS);
  if (duration <= 0) return null;

  if (
    existingExposedLocation
    && existingExposedLocation.gameSessionId === gameConfig.gameSessionId
    && existingExposedLocation.revealScope === activeScope
  ) {
    const remainingValidMs = existingExposedLocation.expiresAt - now;
    const isExpiresAligned =
      Math.abs(existingExposedLocation.expiresAt - targetUntil) < 5000
      || (targetUntil - now > AUTO_EXPOSE_MAX_DURATION_MS && remainingValidMs > 30 * 60 * 1000);

    const hasMoved =
      activeScope === 'PENALTY' && (
        Math.abs(existingExposedLocation.latitude - privateLocation.latitude) > 0.0001
        || Math.abs(existingExposedLocation.longitude - privateLocation.longitude) > 0.0001
      );

    if (isExpiresAligned && !hasMoved) {
      return null;
    }
  }

  return {
    revealScope: activeScope,
    duration,
    targetUntil,
  };
}
