import { doc, serverTimestamp, setDoc, Timestamp, writeBatch } from 'firebase/firestore';
import { db } from './firebaseClient';
import type { ExposedLocationStore, PrivateLocationStore } from '../../application';
import { EMERGENCY_LOCATION_PROJECTION_TTL_MS } from '../../game/emergencyLocationProjection';

export const firebasePrivateLocationStore: PrivateLocationStore = {
  save: async (playerId, location, expectedSessionId) => {
    await setDoc(doc(db, 'privateLocations', playerId), {
      gameSessionId: expectedSessionId,
      latitude: location.latitude,
      longitude: location.longitude,
      updatedAt: serverTimestamp(),
    });
  },
};

export const firebaseEmergencyLocationStore: PrivateLocationStore = {
  save: async (playerId, location, expectedSessionId) => {
    const now = Date.now();
    const batch = writeBatch(db);
    batch.set(doc(db, 'privateLocations', playerId), {
      gameSessionId: expectedSessionId,
      latitude: location.latitude,
      longitude: location.longitude,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'emergencyLocationProjections', playerId), {
      playerId,
      gameSessionId: expectedSessionId,
      latitude: location.latitude,
      longitude: location.longitude,
      projectedAt: serverTimestamp(),
      sourceLocationUpdatedAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + EMERGENCY_LOCATION_PROJECTION_TTL_MS),
      safetyStatus: 'EMERGENCY',
      projectionKind: 'EMERGENCY',
    });
    await batch.commit();
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
