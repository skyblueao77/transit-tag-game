import { doc, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore';
import { db } from './firebaseClient';
import type { ExposedLocationStore, PrivateLocationStore } from '../../application';

export const firebasePrivateLocationStore: PrivateLocationStore = {
  save: async (playerId, location, expectedSessionId) => {
    await setDoc(doc(db, 'privateLocations', playerId), {
      gameSessionId: expectedSessionId,
      latitude: location.latitude,
      longitude: location.longitude,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  },
};

export const firebaseExposedLocationStore: ExposedLocationStore = {
  saveSnapshot: async (playerId, snapshot) => {
    await setDoc(doc(db, 'exposedLocations', playerId), {
      gameSessionId: snapshot.gameSessionId,
      latitude: snapshot.latitude,
      longitude: snapshot.longitude,
      capturedAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(snapshot.expiresAt),
    });
  },
};
