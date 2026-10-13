import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  GameSessionInitializationError,
  initializeGameSessionForAdmin,
} from './gameSessionService';
import type {
  GameSessionInitializationStore,
  GameSessionInitializationTransaction,
} from './gameSessionService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const admins = firestore.collection('admins');
const users = firestore.collection('users');
const configRef = firestore.doc('game_config/current');

const store: GameSessionInitializationStore = {
  runTransaction: work => firestore.runTransaction(transaction => {
    const tx: GameSessionInitializationTransaction = {
      readAdmin: async uid => (await transaction.get(admins.doc(uid))).exists,
      readReceipt: async (uid, requestId) => {
        const snapshot = await transaction.get(admins.doc(uid)
          .collection('sessionInitializationRequests').doc(requestId));
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readConfig: async () => {
        const snapshot = await transaction.get(configRef);
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readParticipants: async () => {
        const snapshot = await transaction.get(users.where('team', 'in', ['A', 'B']));
        return snapshot.docs.map(document => ({ id: document.id, data: document.data() }));
      },
      writeInitialization: (adminUid, { configPatch, playerIds, receipt }) => {
        if (configPatch) transaction.update(configRef, configPatch as never);
        for (const playerId of playerIds) {
          transaction.update(users.doc(playerId), { gameSessionId: receipt.gameSessionId });
        }
        transaction.create(
          admins.doc(adminUid).collection('sessionInitializationRequests').doc(receipt.requestId),
          receipt,
        );
      },
    };
    return work(tx);
  }),
};

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'UNAUTHENTICATED': return 'unauthenticated';
    case 'PERMISSION_DENIED': return 'permission-denied';
    case 'INVALID_ARGUMENT': return 'invalid-argument';
    case 'CONFIG_NOT_FOUND': return 'not-found';
    case 'INVALID_CONFIG':
    case 'SESSION_CHANGED':
    case 'ROSTER_TOO_LARGE': return 'failed-precondition';
    default: return 'internal';
  }
}

export const initializeGameSession = onCall(
  { region: 'asia-northeast1' },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication is required.', {
        reason: 'UNAUTHENTICATED',
      });
    }
    try {
      return await initializeGameSessionForAdmin(
        request.auth.uid,
        request.data,
        store,
        { now: Date.now, createSessionId: randomUUID, createLogId: randomUUID },
      );
    } catch (error) {
      if (error instanceof GameSessionInitializationError) {
        throw new HttpsError(callableCode(error.reason), error.reason, { reason: error.reason });
      }
      logger.error('Game session initialization failed unexpectedly.', { uid: request.auth.uid, error });
      throw new HttpsError('internal', 'Game session initialization failed.', {
        reason: 'PERSISTENCE_ERROR',
      });
    }
  },
);
