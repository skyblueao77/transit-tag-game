import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  AdminRevealServiceError,
  revealPlayerLocationsForAdmin,
} from './adminRevealService';
import type {
  AdminRevealReceipt,
  AdminRevealStore,
  AdminRevealTransaction,
} from './adminRevealService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const admins = firestore.collection('admins');
const users = firestore.collection('users');
const privateLocations = firestore.collection('privateLocations');
const exposedLocations = firestore.collection('exposedLocations');
const configRef = firestore.doc('game_config/current');

const store: AdminRevealStore = {
  runTransaction: work => firestore.runTransaction(async transaction => {
    const revealTransaction: AdminRevealTransaction = {
      readAdmin: async uid => (await transaction.get(admins.doc(uid))).exists,
      readReceipt: async (uid, requestId) => {
        const snapshot = await transaction.get(admins.doc(uid).collection('revealRequests').doc(requestId));
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readGameConfig: async () => {
        const snapshot = await transaction.get(configRef);
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readParticipantRoster: async () => {
        const snapshot = await transaction.get(users.where('team', 'in', ['A', 'B']));
        return snapshot.docs.map(document => ({ id: document.id, data: document.data() }));
      },
      readPrivateLocations: async playerIds => {
        const snapshots = await Promise.all(playerIds.map(playerId => transaction.get(privateLocations.doc(playerId))));
        return snapshots.flatMap(snapshot => snapshot.exists
          ? [{ id: snapshot.id, data: snapshot.data() ?? {} }]
          : []);
      },
      readExistingSnapshots: async playerIds => {
        const snapshots = await Promise.all(playerIds.map(playerId => transaction.get(exposedLocations.doc(playerId))));
        return snapshots.flatMap(snapshot => snapshot.exists
          ? [{ id: snapshot.id, data: snapshot.data() ?? {} }]
          : []);
      },
      writeReveal: (adminUid, configField, expiresAt, snapshots, logs, receipt: AdminRevealReceipt) => {
        transaction.update(configRef, {
          [configField]: Timestamp.fromMillis(expiresAt),
          logs,
        });
        for (const snapshot of snapshots) {
          transaction.set(exposedLocations.doc(snapshot.playerId), {
            playerId: snapshot.playerId,
            latitude: snapshot.latitude,
            longitude: snapshot.longitude,
            capturedAt: Timestamp.fromMillis(snapshot.capturedAt),
            expiresAt: Timestamp.fromMillis(snapshot.expiresAt),
            revealScope: snapshot.revealScope,
          });
        }
        transaction.create(admins.doc(adminUid).collection('revealRequests').doc(receipt.requestId), {
          ...receipt,
          expiresAt: Timestamp.fromMillis(receipt.expiresAt),
          createdAt: Timestamp.fromMillis(receipt.createdAt),
        });
      },
    };
    return work(revealTransaction);
  }),
};

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'UNAUTHENTICATED': return 'unauthenticated';
    case 'PERMISSION_DENIED': return 'permission-denied';
    case 'INVALID_ARGUMENT': return 'invalid-argument';
    case 'CONFIG_NOT_FOUND': return 'not-found';
    case 'INVALID_GAME_CONFIG':
    case 'INVALID_ROSTER':
    case 'ZERO_VALID_LOCATIONS':
    case 'WRITE_LIMIT_EXCEEDED': return 'failed-precondition';
    default: return 'internal';
  }
}

function toHttpsError(error: unknown, uid: string): HttpsError {
  if (error instanceof AdminRevealServiceError) {
    return new HttpsError(callableCode(error.reason), error.reason, { reason: error.reason });
  }
  logger.error('Admin Reveal failed unexpectedly.', { uid, error });
  return new HttpsError('internal', 'Location reveal failed.', { reason: 'PERSISTENCE_ERROR' });
}

export const revealPlayerLocations = onCall(
  { region: 'asia-northeast1' },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication is required.', {
        reason: 'UNAUTHENTICATED',
      });
    }
    try {
      return await revealPlayerLocationsForAdmin(
        request.auth.uid,
        request.data,
        store,
        { now: Date.now, createLogId: randomUUID },
      );
    } catch (error) {
      throw toHttpsError(error, request.auth.uid);
    }
  },
);
