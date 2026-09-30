import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  requestSafetyActionForPlayer,
  SafetyServiceError,
} from './safetyService';
import type {
  SafetyPlayerUpdates,
  SafetyStore,
  SafetyTransaction,
} from './safetyService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const usersCollection = firestore.collection('users');
const configRef = firestore.doc('game_config/current');

const safetyStore: SafetyStore = {
  runTransaction: work => firestore.runTransaction(async transaction => {
    const safetyTransaction: SafetyTransaction = {
      readPlayer: async uid => {
        const snapshot = await transaction.get(usersCollection.doc(uid));
        return snapshot.exists ? { id: snapshot.id, data: snapshot.data() ?? {} } : null;
      },
      readGameConfig: async () => {
        const snapshot = await transaction.get(configRef);
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      writePlayer: (uid: string, updates: SafetyPlayerUpdates) => {
        transaction.update(usersCollection.doc(uid), updates);
      },
      writeLogs: logs => transaction.update(configRef, { logs }),
    };
    return work(safetyTransaction);
  }),
};

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'INVALID_ARGUMENT':
    case 'INVALID_ACTION':
    case 'INVALID_REASON_CODE':
    case 'REASON_ACTION_MISMATCH':
      return 'invalid-argument';
    case 'PLAYER_NOT_FOUND':
    case 'CONFIG_NOT_FOUND':
      return 'not-found';
    case 'PERSISTENCE_ERROR':
      return 'internal';
    default:
      return 'failed-precondition';
  }
}

export const requestSafetyAction = onCall(
  { region: 'asia-northeast1' },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication is required.', {
        reason: 'UNAUTHENTICATED',
      });
    }

    try {
      return await requestSafetyActionForPlayer(
        request.auth.uid,
        request.data,
        safetyStore,
        { now: Date.now, createLogId: randomUUID },
      );
    } catch (error) {
      if (error instanceof SafetyServiceError) {
        throw new HttpsError(callableCode(error.reason), error.reason, { reason: error.reason });
      }
      logger.error('Safety action failed unexpectedly.', { uid: request.auth.uid, error });
      throw new HttpsError('internal', 'Safety action failed.', { reason: 'PERSISTENCE_ERROR' });
    }
  },
);
