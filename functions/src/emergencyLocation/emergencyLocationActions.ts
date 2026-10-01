import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import {
  projectEmergencyLocationForPlayer,
  type EmergencyProjectionStore,
  type EmergencyProjectionTransaction,
  type EmergencyProjectionWrite,
} from './emergencyLocationService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const users = firestore.collection('users');
const locations = firestore.collection('privateLocations');
const projections = firestore.collection('emergencyLocationProjections');

const store: EmergencyProjectionStore = {
  runTransaction: work => firestore.runTransaction(async transaction => {
    const projectionTransaction: EmergencyProjectionTransaction = {
      readPlayer: async uid => {
        const snapshot = await transaction.get(users.doc(uid));
        return snapshot.exists ? { id: snapshot.id, data: snapshot.data() ?? {} } : null;
      },
      readPrivateLocation: async uid => {
        const snapshot = await transaction.get(locations.doc(uid));
        return snapshot.exists ? { id: snapshot.id, data: snapshot.data() ?? {} } : null;
      },
      readProjection: async uid => {
        const snapshot = await transaction.get(projections.doc(uid));
        return snapshot.exists ? { id: snapshot.id, data: snapshot.data() ?? {} } : null;
      },
      writeProjection: (uid: string, projection: EmergencyProjectionWrite) => {
        transaction.set(projections.doc(uid), {
          ...projection,
          projectedAt: Timestamp.fromMillis(projection.projectedAt),
          sourceLocationUpdatedAt: Timestamp.fromMillis(projection.sourceLocationUpdatedAt),
          expiresAt: Timestamp.fromMillis(projection.expiresAt),
        });
      },
      deleteProjection: (uid: string) => transaction.delete(projections.doc(uid)),
    };
    return work(projectionTransaction);
  }),
};

export async function refreshEmergencyLocationProjection(uid: string) {
  return projectEmergencyLocationForPlayer(uid, store, { now: Date.now });
}

async function reconcileProjection(uid: string): Promise<void> {
  const result = await refreshEmergencyLocationProjection(uid);
  if (result.status === 'UNAVAILABLE' || result.status === 'STALE') {
    logger.info('Emergency location projection is unavailable.', { uid, status: result.status });
  }
}

export const onPrivateLocationWritten = onDocumentWritten(
  { document: 'privateLocations/{uid}', region: 'asia-northeast1', retry: true },
  async event => {
    const uid = event.params.uid;
    if (typeof uid === 'string' && uid.length > 0) await reconcileProjection(uid);
  },
);

export const onPlayerWritten = onDocumentWritten(
  { document: 'users/{uid}', region: 'asia-northeast1', retry: true },
  async event => {
    const uid = event.params.uid;
    if (typeof uid === 'string' && uid.length > 0) await reconcileProjection(uid);
  },
);
