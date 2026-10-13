import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import type { CallableRequest } from 'firebase-functions/v2/https';
import {
  administerMissionForAdmin,
  AdminMissionServiceError,
} from './adminMissionService';
import type {
  AdminMissionAction,
  AdminMissionReceipt,
  AdminMissionStore,
  AdminMissionTransaction,
} from './adminMissionService';
import type { Mission } from '../../../types';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const adminsCollection = firestore.collection('admins');
const configRef = firestore.doc('game_config/current');
const missionsCollection = firestore.collection('missions');
const receiptCollections: Record<AdminMissionAction, string> = {
  setMissionMode: 'missionModeRequests',
  assignMissions: 'missionAssignmentRequests',
  syncMissionCatalog: 'missionCatalogSyncRequests',
};

const store: AdminMissionStore = {
  runTransaction: work => firestore.runTransaction(transaction => {
    const tx: AdminMissionTransaction = {
      readAdmin: async uid => (await transaction.get(adminsCollection.doc(uid))).exists,
      readReceipt: async (uid, action, requestId) => {
        const snapshot = await transaction.get(
          adminsCollection.doc(uid).collection(receiptCollections[action]).doc(requestId),
        );
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readConfig: async () => {
        const snapshot = await transaction.get(configRef);
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readMissions: async ids => {
        const snapshots = await Promise.all(ids.map(id => transaction.get(missionsCollection.doc(id))));
        return Object.fromEntries(snapshots.map(snapshot => [snapshot.id, snapshot.exists ? snapshot.data() ?? null : null]));
      },
      updateConfig: patch => transaction.update(configRef, patch as never),
      upsertMission: (id, mission: Mission) => transaction.set(missionsCollection.doc(id), mission),
      createReceipt: (uid, action, requestId, receipt: AdminMissionReceipt) => {
        transaction.create(
          adminsCollection.doc(uid).collection(receiptCollections[action]).doc(requestId),
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
    case 'SESSION_CHANGED': return 'failed-precondition';
    case 'REQUEST_ID_REUSED': return 'already-exists';
    case 'CONFIG_NOT_FOUND': return 'not-found';
    case 'INVALID_CONFIG':
    case 'INVALID_PHASE':
    case 'ASSIGNMENT_NOT_ALLOWED':
    case 'INVALID_MISSION': return 'failed-precondition';
    default: return 'internal';
  }
}

async function handle(request: CallableRequest<unknown>, action: AdminMissionAction) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication is required.', { reason: 'UNAUTHENTICATED' });
  }
  try {
    const data = request.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)
      || Object.prototype.hasOwnProperty.call(data, 'action')) {
      throw new AdminMissionServiceError('INVALID_ARGUMENT');
    }
    const intent = { ...(data as Record<string, unknown>), action };
    return await administerMissionForAdmin(request.auth.uid, intent, store, {
      now: Date.now,
      createId: randomUUID,
      random: Math.random,
    });
  } catch (error) {
    if (error instanceof AdminMissionServiceError) {
      throw new HttpsError(callableCode(error.reason), error.reason, { reason: error.reason });
    }
    logger.error('Admin mission action failed unexpectedly.', { uid: request.auth.uid, action, error });
    throw new HttpsError('internal', 'Admin mission action failed.', { reason: 'PERSISTENCE_ERROR' });
  }
}

export const setMissionMode = onCall(
  { region: 'asia-northeast1' },
  request => handle(request, 'setMissionMode'),
);
export const assignMissions = onCall(
  { region: 'asia-northeast1' },
  request => handle(request, 'assignMissions'),
);
export const syncMissionCatalog = onCall(
  { region: 'asia-northeast1' },
  request => handle(request, 'syncMissionCatalog'),
);
