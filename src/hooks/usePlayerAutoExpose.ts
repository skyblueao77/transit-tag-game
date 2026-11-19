import { useEffect, useRef, useState } from 'react';
import type { ExposedLocation, GameConfig, PrivateLocation, User } from '../../types';
import {
  AUTO_EXPOSE_MAX_DURATION_MS,
  canRevealLocation,
  resolveAutoExposePlan,
  resolvePeriodicRevealWindow,
} from '../game';
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

const WRITE_DEDUPE_COOLDOWN_MS = 15_000;
const SNAPSHOT_REFRESH_LEAD_MS = 28 * 60 * 1000;

export function resolveNextAutoExposeTickDelayMs({
  now,
  gameConfig,
  currentUser,
  existingExposed,
}: {
  now: number;
  gameConfig: Pick<
    GameConfig,
    | 'gameStatus'
    | 'startTime'
    | 'periodicRevealIntervalMinutes'
    | 'periodicRevealDurationMinutes'
    | 'locationRevealUntil'
    | 'teamARevealUntil'
    | 'teamBRevealUntil'
  >;
  currentUser: Pick<User, 'team' | 'penaltyRevealUntil'>;
  existingExposed?: Pick<ExposedLocation, 'expiresAt' | 'revealScope'> | null;
}): number | null {
  const candidates: number[] = [];

  if (gameConfig.startTime) {
    const periodicWindow = resolvePeriodicRevealWindow({
      phase: gameConfig.gameStatus,
      now,
      startTime: gameConfig.startTime,
      intervalMinutes: gameConfig.periodicRevealIntervalMinutes,
      durationMinutes: gameConfig.periodicRevealDurationMinutes,
    });
    if (periodicWindow.isActive && periodicWindow.activeUntil !== undefined) {
      candidates.push(Math.min(60_000, Math.max(1000, periodicWindow.activeUntil - now + 250)));
    } else if (periodicWindow.nextWindowStart !== undefined) {
      candidates.push(Math.min(60_000, Math.max(1000, periodicWindow.nextWindowStart - now + 250)));
    }
  }

  const penaltyUntil = typeof currentUser.penaltyRevealUntil === 'number' ? currentUser.penaltyRevealUntil : 0;
  const globalUntil = typeof gameConfig.locationRevealUntil === 'number' ? gameConfig.locationRevealUntil : 0;
  const teamUntil = currentUser.team === 'A'
    ? (typeof gameConfig.teamARevealUntil === 'number' ? gameConfig.teamARevealUntil : 0)
    : currentUser.team === 'B'
      ? (typeof gameConfig.teamBRevealUntil === 'number' ? gameConfig.teamBRevealUntil : 0)
      : 0;
  const maxActiveTargetUntil = Math.max(penaltyUntil, globalUntil, teamUntil);

  if (maxActiveTargetUntil > now) {
    // Schedule a re-check before a 58-minute capped snapshot expires (or right at expiry)
    if (existingExposed && existingExposed.expiresAt > now && maxActiveTargetUntil > existingExposed.expiresAt + 5000) {
      const timeUntilRefreshThreshold = existingExposed.expiresAt - 30 * 60 * 1000 - now + 250;
      candidates.push(Math.max(1000, Math.min(60_000, timeUntilRefreshThreshold)));
    } else if (maxActiveTargetUntil - now > AUTO_EXPOSE_MAX_DURATION_MS) {
      candidates.push(Math.min(60_000, SNAPSHOT_REFRESH_LEAD_MS));
    }
  }

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
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
  const inFlightKeyRef = useRef<string | null>(null);
  const lastWrittenRef = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    void windowTick;
    if (
      !isOnline
      || isAdmin
      || !currentUser
      || currentUser.status === 'EMERGENCY'
      || currentUser.status === 'RETIRED'
      || !canRevealLocation(gameConfig.gameStatus)
    ) {
      return;
    }

    const now = getServerNowMs();
    const existing = exposedLocations[currentUser.id];
    const nextCheckMs = resolveNextAutoExposeTickDelayMs({
      now,
      gameConfig,
      currentUser,
      existingExposed: existing,
    });
    if (nextCheckMs === null) return;

    const timer = window.setTimeout(() => {
      setWindowTick(tick => tick + 1);
    }, nextCheckMs);
    return () => window.clearTimeout(timer);
  }, [
    isOnline,
    isAdmin,
    currentUser,
    gameConfig,
    exposedLocations,
    windowTick,
  ]);

  useEffect(() => {
    void windowTick;
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

    const writeKey = [
      gameConfig.gameSessionId,
      currentUser.id,
      plan.revealScope,
      Math.round(plan.targetUntil / 1000),
      Math.round(plan.duration / 60_000),
      privateLocation.latitude.toFixed(5),
      privateLocation.longitude.toFixed(5),
    ].join(':');

    if (inFlightKeyRef.current === writeKey) {
      return;
    }
    if (
      lastWrittenRef.current
      && lastWrittenRef.current.key === writeKey
      && now - lastWrittenRef.current.at < WRITE_DEDUPE_COOLDOWN_MS
    ) {
      return;
    }

    let cancelled = false;
    inFlightKeyRef.current = writeKey;

    void exposeLocation({
      playerId: currentUser.id,
      expectedSessionId: gameConfig.gameSessionId,
      privateLocation,
      phase: gameConfig.gameStatus,
      now,
      duration: plan.duration,
      revealScope: plan.revealScope,
    }, firebaseExposedLocationStore)
      .then(result => {
        if (cancelled) return;
        if (result.ok) {
          lastWrittenRef.current = { key: writeKey, at: getServerNowMs() };
        }
      })
      .catch(error => {
        console.error('Failed to auto-expose player location:', error);
      })
      .finally(() => {
        if (inFlightKeyRef.current === writeKey) {
          inFlightKeyRef.current = null;
        }
      });

    return () => {
      cancelled = true;
    };
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
