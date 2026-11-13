import { useEffect, useState } from 'react';
import { DEFAULT_DYNAMIC_RULE_SETTINGS } from '../../constants';
import { computeMapTimeLeft, type MapTimeLeft } from '../game';
import type { GameConfig, Role, User } from '../../types';

export default function useMapTimers(
  currentUser: User,
  gameConfig: GameConfig,
  currentRole: Role,
): { timeLeft: MapTimeLeft; nowMs: number } {
  const [state, setState] = useState<{ timeLeft: MapTimeLeft; nowMs: number }>(() => {
    const now = Date.now();
    return {
      nowMs: now,
      timeLeft: computeMapTimeLeft({
        currentUser,
        gameConfig,
        currentRole,
        now,
        defaultShinkansenMaxMinutes: DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxMinutes,
      }),
    };
  });

  useEffect(() => {
    const update = () => {
      const now = Date.now();
      setState(previous => ({
        nowMs: now,
        timeLeft: computeMapTimeLeft(
          {
            currentUser,
            gameConfig,
            currentRole,
            now,
            defaultShinkansenMaxMinutes: DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxMinutes,
          },
          previous.timeLeft,
        ),
      }));
    };

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [currentUser, gameConfig, currentRole]);

  return state;
}
