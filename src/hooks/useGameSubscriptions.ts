import { useState, useEffect, useMemo, useRef } from 'react';
import type { GameConfig, User, Mission, PrivateLocation, ExposedLocation } from '../../types';
import { INITIAL_GAME_CONFIG } from '../../constants';
import {
  createExposedLocationsSubscriber,
  type ExposedLocationsSubscriber,
  subscribeGameConfig,
  subscribeMissions,
  subscribePlayers,
  subscribePrivateLocation,
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
): UseGameSubscriptionsResult {
  const [rawUsers, setRawUsers] = useState<User[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [gameConfig, setGameConfig] = useState<GameConfig>(INITIAL_GAME_CONFIG);
  const [privateLocation, setPrivateLocation] = useState<PrivateLocation | null>(null);
  const [exposedLocations, setExposedLocations] = useState<Record<string, ExposedLocation>>({});
  const lastBroadcastTimeRef = useRef<number | null>(null);
  const exposedSubscriberRef = useRef<ExposedLocationsSubscriber | null>(null);

  const allUsers = useMemo(
    () => (gameConfig.gameSessionId
      ? rawUsers.filter(user => user.gameSessionId === gameConfig.gameSessionId)
      : rawUsers),
    [rawUsers, gameConfig.gameSessionId],
  );

  const exposedPlayerIdsJson = useMemo(
    () => JSON.stringify(
      allUsers
        .filter(
          user => (user.team === 'A' || user.team === 'B')
            && user.status !== 'EMERGENCY'
            && user.status !== 'RETIRED',
        )
        .map(user => user.id),
    ),
    [allUsers],
  );
  const exposedPlayerIdsRef = useRef<string[]>([]);
  exposedPlayerIdsRef.current = JSON.parse(exposedPlayerIdsJson) as string[];

  useEffect(() => {
    if (!authUserId) {
      setRawUsers([]);
      return;
    }
    return subscribePlayers(
      setRawUsers,
      error => console.error('Error fetching users data:', error),
    );
  }, [authUserId]);

  useEffect(() => {
    if (!authUserId || !gameConfig.gameSessionId) {
      setPrivateLocation(null);
      return;
    }
    return subscribePrivateLocation(
      authUserId,
      gameConfig.gameSessionId,
      setPrivateLocation,
      error => {
        console.error('Error fetching private location:', error);
        setPrivateLocation(null);
      },
    );
  }, [authUserId, gameConfig.gameSessionId]);

  useEffect(() => {
    if (!authUserId) {
      setExposedLocations({});
      exposedSubscriberRef.current = null;
      return;
    }
    const subscriber = createExposedLocationsSubscriber(
      gameConfig.gameSessionId ?? '',
      setExposedLocations,
      error => console.error('Error fetching exposed locations:', error),
    );
    exposedSubscriberRef.current = subscriber;
    subscriber.setPlayerIds(exposedPlayerIdsRef.current);
    return () => {
      if (exposedSubscriberRef.current === subscriber) {
        exposedSubscriberRef.current = null;
      }
      subscriber.dispose();
    };
  }, [authUserId, gameConfig.gameSessionId]);

  useEffect(() => {
    if (!authUserId) return;
    exposedSubscriberRef.current?.setPlayerIds(JSON.parse(exposedPlayerIdsJson) as string[]);
  }, [authUserId, exposedPlayerIdsJson]);

  useEffect(() => {
    if (!authUserId) return;
    return subscribeMissions(
      setMissions,
      error => console.error('Error fetching missions data:', error),
    );
  }, [authUserId]);

  useEffect(() => {
    if (!authUserId) return;
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
  }, [authUserId, onBroadcast, onConfigError]);

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
