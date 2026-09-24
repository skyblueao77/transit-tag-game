import { doc, increment, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../../../firebase';
import type {
  CaptureStore,
  MissionCompletionStore,
  PowerupStore,
} from '../../application';

export const firebaseMissionCompletionStore: MissionCompletionStore = {
  applyMissionCompletion: async input => {
    const batch = writeBatch(db);
    const configRef = doc(db, 'game_config', 'current');
    const playerRef = doc(db, 'users', input.playerId);
    const teamScoreField = input.team === 'A' ? 'teamAScore' : 'teamBScore';

    batch.update(configRef, { [teamScoreField]: increment(input.teamScoreDelta) });
    const playerUpdate: Record<string, unknown> = {
      score: increment(input.playerScoreDelta),
    };
    if (input.invincibleCardDelta !== 0) {
      playerUpdate.invincibleCards = increment(input.invincibleCardDelta);
    }
    batch.update(playerRef, playerUpdate);
    await batch.commit();
  },
};

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
