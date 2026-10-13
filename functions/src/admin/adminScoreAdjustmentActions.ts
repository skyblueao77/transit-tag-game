import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { CallableRequest } from 'firebase-functions/v2/https';
import {
  adjustTeamScoreForAdmin,
  AdminScoreAdjustmentServiceError,
} from './adminScoreAdjustmentService';
import type {
  AdminScoreAdjustmentStore,
  AdminScoreAdjustmentTransaction,
  TeamScoreAdjustmentReceipt,
} from './adminScoreAdjustmentService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const admins = firestore.collection('admins');
const configRef = firestore.doc('game_config/current');

const store: AdminScoreAdjustmentStore = {
  runTransaction: work => firestore.runTransaction(transaction => {
    const scoreTransaction: AdminScoreAdjustmentTransaction = {
      readAdmin: async uid => (await transaction.get(admins.doc(uid))).exists,
      readReceipt: async (uid, requestId) => {
        const snapshot = await transaction.get(admins.doc(uid).collection('scoreAdjustmentRequests').doc(requestId));
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readConfig: async () => {
        const snapshot = await transaction.get(configRef);
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      writeAdjustment: (scoreField, nextScore, logs, uid, requestId, receipt: TeamScoreAdjustmentReceipt) => {
        transaction.update(configRef, { [scoreField]: nextScore, logs });
        transaction.create(admins.doc(uid).collection('scoreAdjustmentRequests').doc(requestId), receipt);
      },
    };
    return work(scoreTransaction);
  }),
};

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'UNAUTHENTICATED': return 'unauthenticated';
    case 'PERMISSION_DENIED': return 'permission-denied';
    case 'INVALID_ARGUMENT': return 'invalid-argument';
        case 'SESSION_CHANGED': return 'failed-precondition';
    case 'CONFIG_NOT_FOUND': return 'not-found';
    case 'REQUEST_ID_REUSED': return 'already-exists';
    case 'INVALID_CONFIG':
    case 'SCORE_BELOW_ZERO': return 'failed-precondition';
    default: return 'internal';
  }
}

async function handleAdjustTeamScore(request: CallableRequest<unknown>) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication is required.', { reason: 'UNAUTHENTICATED' });
  }
  try {
    return await adjustTeamScoreForAdmin(request.auth.uid, request.data, store, {
      now: Date.now,
      createLogId: randomUUID,
    });
  } catch (error) {
    if (error instanceof AdminScoreAdjustmentServiceError) {
      throw new HttpsError(callableCode(error.reason), error.reason, { reason: error.reason });
    }
    logger.error('Admin score adjustment failed unexpectedly.', { uid: request.auth.uid, error });
    throw new HttpsError('internal', 'Score adjustment failed.', { reason: 'PERSISTENCE_ERROR' });
  }
}

export const adjustTeamScore = onCall(
  { region: 'asia-northeast1' },
  handleAdjustTeamScore,
);
