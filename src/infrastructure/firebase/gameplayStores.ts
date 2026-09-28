import { doc, updateDoc } from 'firebase/firestore';
import { db } from './firebaseClient';
import type { GameLog } from '../../../types';

export const firebaseGameLogStore = {
  append: async (log: GameLog, previousLogs: GameLog[]): Promise<void> => {
    await updateDoc(doc(db, 'game_config', 'current'), {
      logs: [log, ...previousLogs].slice(0, 200),
    });
  },
};
