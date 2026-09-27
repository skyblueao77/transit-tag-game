import { doc, increment, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebaseClient';
import type { GameLog } from '../../../types';
import type {
  CaptureStore,
  PowerupStore,
} from '../../application';


export const firebaseCaptureStore: CaptureStore = {
  applyCapture: async result => {
    const batch = writeBatch(db);
    const configRef = doc(db, 'game_config', 'current');
    const scoreField = result.reward.team === 'A' ? 'teamAScore' : 'teamBScore';

    batch.update(configRef, {
      teamARole: result.teamRoles.teamARole,
      teamBRole: result.teamRoles.teamBRole,
      nextRevealTime: result.nextRevealTime,
      [scoreField]: increment(result.reward.scoreDelta),
    });

    for (const change of result.playerChanges) {
      const updates: Record<string, unknown> = {
        status: change.status,
        waitingUntil: change.waitingUntil,
      };
      if (change.invincibleUntil !== undefined) {
        updates.invincibleUntil = change.invincibleUntil;
      }
      if (change.invincibleCardsDelta !== 0) {
        updates.invincibleCards = increment(change.invincibleCardsDelta);
      }
      batch.set(doc(db, 'users', change.playerId), updates, { merge: true });
    }

    await batch.commit();
  },
};

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
