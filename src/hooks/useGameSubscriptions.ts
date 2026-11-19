import { useState, useEffect, useMemo, useRef } from 'react';
import type { GameConfig, User, Mission, PrivateLocation, ExposedLocation } from '../../types';
import { INITIAL_GAME_CONFIG } from '../../constants';
import { canRevealLocation, hasActiveRevealWindow } from '../game';
import { getServerNowMs } from '../infrastructure/firebase/serverClock';
import {
  createExposedLocationsSubscriber,
  type ExposedLocationsSubscriber,
  fetchPrivateLocation,
  subscribeGameConfig,
  subscribeMissions,
  subscribePlayers,
} from '../infrastructure/firebase/subscriptions';

export interface UseGameSubscriptionsResult {
  allUsers: User[];
  missions: Mission[];
  gameConfig: GameConfig;
  privateLocation: PrivateLocation | null;
  exposedLocations: Record<string, ExposedLocation>;
  setGameConfig: React.Dispatch<React.SetStateAction<GameConfig>>;
  setPrivateLocation: React.Dispatch<React.SetStateAction<PrivateLocation | null>>;
}

export function useGameSubscriptions(
  authUserId: string | null,
  onBroadcast?: (message: string) => void,
  onConfigError?: (error: Error) => void,
  canSubscribeParticipants: boolean = Boolean(authUserId),
  onSubscriptionError?: (source: 'players' | 'missions' | 'exposedLocations', error: Error) => void,
  canSubscribeConfig: boolean = Boolean(authUserId),
): UseGameSubscriptionsResult {
  const [rawUsers, setRawUsers] = useState<User[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [gameConfig, setGameConfig] = useState<GameConfig>(INITIAL_GAME_CONFIG);
  const [privateLocation, setPrivateLocation] = useState<PrivateLocation | null>(null);
  const [exposedLocations, setExposedLocations] = useState<Record<string, ExposedLocation>>({});
  const [exposeWindowNowMs, setExposeWindowNowMs] = useState<number>(() => getServerNowMs());
  const lastBroadcastTimeRef = useRef<number | null>(null);
  const exposedSubscriberRef = useRef<ExposedLocationsSubscriber | null>(null);

  const allUsers = useMemo(
    () => (gameConfig.gameSessionId
      ? rawUsers.filter(user => user.gameSessionId === gameConfig.gameSessionId)
      : rawUsers),
    [rawUsers, gameConfig.gameSessionId],
  );

  const exposedPlayerIds = useMemo(
    () => allUsers
      .filter(
        user => (user.team === 'A' || user.team === 'B')
          && user.status !== 'EMERGENCY'
          && user.status !== 'RETIRED',
      )
      .map(user => user.id)
      .sort(),
    [allUsers],
  );
  const exposedPlayerIdsKey = useMemo(() => exposedPlayerIds.join(','), [exposedPlayerIds]);
  const exposedPlayerIdsRef = useRef<string[]>([]);
  exposedPlayerIdsRef.current = exposedPlayerIds;

  useEffect(() => {
    if (!authUserId || !canSubscribeParticipants || !canRevealLocation(gameConfig.gameStatus)) {
      return;
    }
    setExposeWindowNowMs(getServerNowMs());
    const timer = window.setInterval(() => {
      setExposeWindowNowMs(getServerNowMs());
    }, 5000);
    return () => window.clearInterval(timer);
  }, [authUserId, canSubscribeParticipants, gameConfig.gameStatus]);

  const isExposeWindowActive = useMemo(
    () => Boolean(authUserId && canSubscribeParticipants) && hasActiveRevealWindow({
      phase: gameConfig.gameStatus,
      locationRevealUntil: gameConfig.locationRevealUntil,
      teamARevealUntil: gameConfig.teamARevealUntil,
      teamBRevealUntil: gameConfig.teamBRevealUntil,
      startTime: gameConfig.startTime,
      periodicRevealIntervalMinutes: gameConfig.periodicRevealIntervalMinutes,
      periodicRevealDurationMinutes: gameConfig.periodicRevealDurationMinutes,
      players: allUsers,
    }, exposeWindowNowMs),
    [
      authUserId,
      canSubscribeParticipants,
      gameConfig.gameStatus,
      gameConfig.locationRevealUntil,
      gameConfig.teamARevealUntil,
      gameConfig.teamBRevealUntil,
      gameConfig.startTime,
      gameConfig.periodicRevealIntervalMinutes,
      gameConfig.periodicRevealDurationMinutes,
      allUsers,
      exposeWindowNowMs,
    ],
  );

  useEffect(() => {
    if (!authUserId || !canSubscribeParticipants) {
      setRawUsers([]);
      return;
    }
    return subscribePlayers(
      setRawUsers,
      error => {
        console.error('Error fetching users data:', error);
        onSubscriptionError?.('players', error);
      },
    );
  }, [authUserId, canSubscribeParticipants, onSubscriptionError]);

  useEffect(() => {
    if (!authUserId || !gameConfig.gameSessionId) {
      setPrivateLocation(null);
      return;
    }
    let cancelled = false;
    void fetchPrivateLocation(authUserId, gameConfig.gameSessionId)
      .then(location => {
        if (!cancelled) {
          setPrivateLocation(location);
        }
      })
      .catch(error => {
        console.error('Error fetching private location:', error);
        if (!cancelled) {
          setPrivateLocation(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authUserId, gameConfig.gameSessionId]);

  useEffect(() => {
    if (!authUserId || !canSubscribeParticipants || !isExposeWindowActive) {
      setExposedLocations({});
      exposedSubscriberRef.current = null;
      return;
    }
    const subscriber = createExposedLocationsSubscriber(
      gameConfig.gameSessionId ?? '',
      setExposedLocations,
      error => {
        console.error('Error fetching exposed locations:', error);
        onSubscriptionError?.('exposedLocations', error);
      },
    );
    exposedSubscriberRef.current = subscriber;
    subscriber.setPlayerIds(exposedPlayerIdsRef.current);
    return () => {
      if (exposedSubscriberRef.current === subscriber) {
        exposedSubscriberRef.current = null;
      }
      subscriber.dispose();
    };
  }, [authUserId, canSubscribeParticipants, gameConfig.gameSessionId, isExposeWindowActive, onSubscriptionError]);

  useEffect(() => {
    if (!authUserId || !canSubscribeParticipants || !isExposeWindowActive) return;
    if (exposedPlayerIdsKey === '') {
      exposedSubscriberRef.current?.setPlayerIds([]);
      return;
    }
    exposedSubscriberRef.current?.setPlayerIds(exposedPlayerIdsRef.current);
  }, [authUserId, canSubscribeParticipants, isExposeWindowActive, exposedPlayerIdsKey]);

  useEffect(() => {
    if (!authUserId || !canSubscribeParticipants) {
      setMissions([]);
      return;
    }
    return subscribeMissions(
      setMissions,
      error => {
        console.error('Error fetching missions data:', error);
        onSubscriptionError?.('missions', error);
      },
    );
  }, [authUserId, canSubscribeParticipants, onSubscriptionError]);

  useEffect(() => {
    if (!authUserId || !canSubscribeConfig) {
      setGameConfig(INITIAL_GAME_CONFIG);
      lastBroadcastTimeRef.current = null;
      return;
    }
    return subscribeGameConfig(
      INITIAL_GAME_CONFIG,
      config => {
        setGameConfig(config);
        const broadcastTs = config.broadcastTime ?? 0;
        if (lastBroadcastTimeRef.current === null) {
          lastBroadcastTimeRef.current = broadcastTs;
          return;
        }
        if (config.broadcastMessage && broadcastTs > lastBroadcastTimeRef.current) {
          lastBroadcastTimeRef.current = broadcastTs;
          onBroadcast?.(config.broadcastMessage);
        }
      },
      error => {
        console.error('Error fetching game config data:', error);
        onConfigError?.(error as Error);
      },
    );
  }, [authUserId, canSubscribeConfig, onBroadcast, onConfigError]);

  return {
    allUsers,
    missions,
    gameConfig,
    privateLocation,
    exposedLocations,
    setGameConfig,
    setPrivateLocation,
  };
}

export default useGameSubscriptions;
