import { doc, getDocFromServer, serverTimestamp, setDoc, Timestamp, writeBatch } from 'firebase/firestore';
import { db } from './firebaseClient';
import type { ExposedLocationStore, PrivateLocationStore } from '../../application';
import { EMERGENCY_LOCATION_PROJECTION_TTL_MS } from '../../game/emergencyLocationProjection';
import {
  getServerNowMs,
  isServerClockCalibrated,
  markServerTimestampWriteSent,
  recordConfirmedServerTimestamp,
} from './serverClock';

export const PRIVATE_LOCATION_TTL_MS = 48 * 60 * 60 * 1000;

export const firebasePrivateLocationStore: PrivateLocationStore = {
  save: async (playerId, location, expectedSessionId) => {
    const shouldCalibrate = !isServerClockCalibrated();
    if (shouldCalibrate) {
      markServerTimestampWriteSent();
    }
    const docRef = doc(db, 'privateLocations', playerId);
    const now = getServerNowMs();
    await setDoc(docRef, {
      gameSessionId: expectedSessionId,
      latitude: location.latitude,
      longitude: location.longitude,
      updatedAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + PRIVATE_LOCATION_TTL_MS),
    });
    if (shouldCalibrate) {
      try {
        const confirmedSnap = await getDocFromServer(docRef);
        const updatedAt = confirmedSnap.data()?.updatedAt;
        if (updatedAt && typeof updatedAt === 'object' && 'toMillis' in updatedAt && typeof updatedAt.toMillis === 'function') {
          recordConfirmedServerTimestamp(updatedAt.toMillis(), {
            hasPendingWrites: confirmedSnap.metadata.hasPendingWrites,
            fromCache: confirmedSnap.metadata.fromCache,
          });
        }
      } catch {
        // Best-effort clock calibration; keep local estimate on offline/error.
      }
    }
  },
};

export const firebaseEmergencyLocationStore: PrivateLocationStore = {
  save: async (playerId, location, expectedSessionId) => {
    const now = getServerNowMs();
    const batch = writeBatch(db);
    batch.set(doc(db, 'privateLocations', playerId), {
      gameSessionId: expectedSessionId,
      latitude: location.latitude,
      longitude: location.longitude,
      updatedAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + PRIVATE_LOCATION_TTL_MS),
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
    markServerTimestampWriteSent();
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
      ...(snapshot.revealScope ? { revealScope: snapshot.revealScope, playerId } : {}),
    });
  },
};
