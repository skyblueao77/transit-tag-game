import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  executeGameResetForAdmin,
  GameResetServiceError,
  prepareGameResetForAdmin,
} from './gameResetService';
import type { GameResetStore, GameResetTransaction, ResetCollectionName } from './gameResetService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const admins = firestore.collection('admins');
const users = firestore.collection('users');
const configRef = firestore.doc('game_config/current');
const collections = {
  privateLocations: firestore.collection('privateLocations'),
  exposedLocations: firestore.collection('exposedLocations'),
  emergencyLocationProjections: firestore.collection('emergencyLocationProjections'),
};

const store: GameResetStore = {
  runTransaction: work => firestore.runTransaction(async transaction => {
    const resetTransaction: GameResetTransaction = {
      readAdmin: async uid => (await transaction.get(admins.doc(uid))).exists,
      readConfig: async () => {
        const snapshot = await transaction.get(configRef);
        const updateTime = snapshot.updateTime;
        return snapshot.exists
          ? { data: snapshot.data() ?? {}, revision: updateTime ? `${updateTime.seconds}:${updateTime.nanoseconds}` : '' }
          : null;
      },
      readParticipants: async () => {
        const snapshot = await transaction.get(users.where('team', 'in', ['A', 'B']));
        return snapshot.docs.map(document => ({
          id: document.id,
          team: document.get('team'),
          revision: String(document.updateTime?.toMillis() ?? ''),
        }));
      },
      readCollection: async (name: ResetCollectionName) => {
        const snapshot = await transaction.get(collections[name]);
        return snapshot.docs.map(document => ({
          id: document.id,
          data: document.data(),
          revision: String(document.updateTime?.toMillis() ?? ''),
        }));
      },
      readConfirmation: async (uid, tokenId) => {
        const snapshot = await transaction.get(admins.doc(uid).collection('resetConfirmations').doc(tokenId));
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readResetReceipt: async (uid, requestId) => {
        const snapshot = await transaction.get(admins.doc(uid).collection('gameResetRequests').doc(requestId));
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      createConfirmation: (uid, tokenId, confirmation) => {
        transaction.create(admins.doc(uid).collection('resetConfirmations').doc(tokenId), confirmation);
      },
      writeReset: commit => {
        transaction.update(configRef, commit.configPatch as never);
        for (const participantId of commit.participantIds) {
          transaction.update(users.doc(participantId), commit.playerPatch as never);
        }
        for (const name of ['privateLocations', 'exposedLocations', 'emergencyLocationProjections'] as const) {
          for (const documentId of commit.locationIds[name]) {
            transaction.delete(collections[name].doc(documentId));
          }
        }
        transaction.update(admins.doc(commit.adminUid).collection('resetConfirmations').doc(commit.confirmationToken), {
          used: true,
          usedAt: commit.completedAt,
        });
        transaction.create(admins.doc(commit.adminUid).collection('gameResetRequests').doc(commit.requestId), commit.receipt);
      },
    };
    return work(resetTransaction);
  }),
};

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'UNAUTHENTICATED': return 'unauthenticated';
    case 'PERMISSION_DENIED': return 'permission-denied';
    case 'INVALID_ARGUMENT': return 'invalid-argument';
    case 'CONFIG_NOT_FOUND':
    case 'CONFIRMATION_NOT_FOUND': return 'not-found';
    case 'REQUEST_ID_REUSED':
    case 'CONFIRMATION_ALREADY_USED': return 'already-exists';
    case 'INVALID_CONFIG':
    case 'RESET_NOT_READY':
    case 'CONFIRMATION_EXPIRED':
    case 'SESSION_CHANGED':
    case 'CONFIRMATION_STALE':
    case 'RESET_TOO_LARGE': return 'failed-precondition';
    default: return 'internal';
  }
}

function toHttpsError(error: unknown, uid: string, action: string): HttpsError {
  if (error instanceof GameResetServiceError) {
    return new HttpsError(callableCode(error.reason), error.reason, { reason: error.reason });
  }
  logger.error(`Game reset ${action} failed unexpectedly.`, { uid, error });
  return new HttpsError('internal', 'Game reset request failed.', { reason: 'PERSISTENCE_ERROR' });
}

export const prepareGameReset = onCall({ region: 'asia-northeast1' }, async request => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication is required.', { reason: 'UNAUTHENTICATED' });
  }
  try {
    return await prepareGameResetForAdmin(request.auth.uid, request.data, store, {
      now: Date.now,
      createTokenId: randomUUID,
      createProposedSessionId: randomUUID,
    });
  } catch (error) {
    throw toHttpsError(error, request.auth.uid, 'prepare');
  }
});

export const executeGameReset = onCall({ region: 'asia-northeast1' }, async request => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication is required.', { reason: 'UNAUTHENTICATED' });
  }
  try {
    return await executeGameResetForAdmin(request.auth.uid, request.data, store, {
      now: Date.now,
      createLogId: randomUUID,
    });
  } catch (error) {
    throw toHttpsError(error, request.auth.uid, 'execute');
  }
});
