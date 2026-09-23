import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../../../firebase';
import type { ExposedLocationStore, PrivateLocationStore } from '../../application';

export const firebasePrivateLocationStore: PrivateLocationStore = {
  save: async (playerId, location) => {
    await setDoc(doc(db, 'privateLocations', playerId), {
      latitude: location.latitude,
      longitude: location.longitude,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  },
};

export const firebaseExposedLocationStore: ExposedLocationStore = {
  saveSnapshot: async (playerId, snapshot) => {
    await setDoc(doc(db, 'exposedLocations', playerId), {
      latitude: snapshot.latitude,
      longitude: snapshot.longitude,
      capturedAt: serverTimestamp(),
      expiresAt: snapshot.expiresAt,
    });
  },
};
