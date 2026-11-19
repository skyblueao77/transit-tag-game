import { useEffect, useState } from 'react';
import { DEFAULT_DYNAMIC_RULE_SETTINGS } from '../../constants';
import { computeMapTimeLeft, type MapTimeLeft } from '../game';
import { getServerNowMs } from '../infrastructure/firebase/serverClock';
import type { GameConfig, Role, User } from '../../types';

function isSameMapTimeLeft(a: MapTimeLeft, b: MapTimeLeft): boolean {
  return (
    a.waiting === b.waiting
    && a.invincible === b.invincible
    && a.nextReveal === b.nextReveal
    && a.periodicRevealRemaining === b.periodicRevealRemaining
    && a.final === b.final
    && a.oniLock === b.oniLock
    && a.shinkansenRemaining === b.shinkansenRemaining
    && a.forceReveal === b.forceReveal
    && a.teamSearchRemaining === b.teamSearchRemaining
    && a.penaltyRemaining === b.penaltyRemaining
  );
}

export default function useMapTimers(
  currentUser: User,
  gameConfig: GameConfig,
  currentRole: Role,
): { timeLeft: MapTimeLeft; nowMs: number } {
  const [state, setState] = useState<{ timeLeft: MapTimeLeft; nowMs: number }>(() => {
    const now = getServerNowMs();
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
      const now = getServerNowMs();
      setState(previous => {
        const nextTimeLeft = computeMapTimeLeft(
          {
            currentUser,
            gameConfig,
            currentRole,
            now,
            defaultShinkansenMaxMinutes: DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxMinutes,
          },
          previous.timeLeft,
        );
        const prevEpoch5s = Math.floor(previous.nowMs / 5000);
        const nextEpoch5s = Math.floor(now / 5000);
        if (isSameMapTimeLeft(previous.timeLeft, nextTimeLeft) && prevEpoch5s === nextEpoch5s) {
          return previous;
        }
        return {
          nowMs: now,
          timeLeft: isSameMapTimeLeft(previous.timeLeft, nextTimeLeft) ? previous.timeLeft : nextTimeLeft,
        };
      });
    };

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [currentUser, gameConfig, currentRole]);

  return state;
}
