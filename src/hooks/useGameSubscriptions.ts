import { useState, useEffect, useMemo, useRef } from 'react';
import type { GameConfig, User, Mission, PrivateLocation, ExposedLocation } from '../../types';
import { INITIAL_GAME_CONFIG } from '../../constants';
import {
  subscribeExposedLocations,
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
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [gameConfig, setGameConfig] = useState<GameConfig>(INITIAL_GAME_CONFIG);
  const [privateLocation, setPrivateLocation] = useState<PrivateLocation | null>(null);
  const [exposedLocations, setExposedLocations] = useState<Record<string, ExposedLocation>>({});
  const lastBroadcastTimeRef = useRef<number | null>(null);

  const exposedPlayerIdsJson = useMemo(
    () => JSON.stringify(allUsers.filter(user => user.team === 'A' || user.team === 'B').map(user => user.id)),
    [allUsers],
  );

  useEffect(() => {
    if (!authUserId) {
      setAllUsers([]);
      return;
    }
    const currentSession = gameConfig.gameSessionId;
    return subscribePlayers(
      players => {
        if (currentSession) {
          setAllUsers(players);
        } else {
          setAllUsers(players);
        }
      },
      error => console.error('Error fetching users data:', error),
    );
  }, [authUserId, gameConfig.gameSessionId]);

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
      return;
    }
    const playerIds = JSON.parse(exposedPlayerIdsJson) as string[];
    setExposedLocations({});
    return subscribeExposedLocations(
      playerIds,
      gameConfig.gameSessionId ?? '',
      setExposedLocations,
      error => console.error('Error fetching exposed locations:', error),
    );
  }, [authUserId, exposedPlayerIdsJson, gameConfig.gameSessionId]);

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
