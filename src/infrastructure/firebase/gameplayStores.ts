import { doc, increment, updateDoc } from 'firebase/firestore';
import { db } from './firebaseClient';
import type { GameLog } from '../../../types';
import type { PowerupStore } from '../../application';

export const firebasePowerupStore: PowerupStore = {
  applyInvincibility: async input => {
    await updateDoc(doc(db, 'users', input.playerId), {
      invincibleUntil: input.invincibleUntil,
      invincibleCards: increment(input.cardDelta),
    });
  },
};

export const firebaseGameLogStore = {
  append: async (log: GameLog, previousLogs: GameLog[]): Promise<void> => {
    await updateDoc(doc(db, 'game_config', 'current'), {
      logs: [log, ...previousLogs].slice(0, 200),
    });
  },
};
