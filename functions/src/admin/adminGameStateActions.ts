import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  resumePlayerForAdmin,
  swapTeamRolesForAdmin,
  AdminGameStateServiceError,
} from './adminGameStateService';
import type {
  AdminGameStateStore,
  AdminGameStateTransaction,
  AdminPlayerUpdates,
  AdminRoleSwapReceipt,
} from './adminGameStateService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const adminsCollection = firestore.collection('admins');
const usersCollection = firestore.collection('users');
const configRef = firestore.doc('game_config/current');

const adminGameStateStore: AdminGameStateStore = {
  runTransaction: work => firestore.runTransaction(async transaction => {
    const adminTransaction: AdminGameStateTransaction = {
      readAdmin: async uid => (await transaction.get(adminsCollection.doc(uid))).exists,
      readRoleSwapReceipt: async (uid, requestId) => {
        const snapshot = await transaction.get(
          adminsCollection.doc(uid).collection('roleSwapRequests').doc(requestId),
        );
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readGameConfig: async () => {
        const snapshot = await transaction.get(configRef);
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readParticipantRoster: async () => {
        const snapshot = await transaction.get(usersCollection.where('team', 'in', ['A', 'B']));
        return snapshot.docs.map(document => ({ id: document.id, data: document.data() }));
      },
      readPlayer: async playerId => {
        const snapshot = await transaction.get(usersCollection.doc(playerId));
        return snapshot.exists ? { id: snapshot.id, data: snapshot.data() ?? {} } : null;
      },
      writeRoleSwap: (adminUid, config, players, logs, receipt: AdminRoleSwapReceipt) => {
        transaction.update(configRef, { ...config, logs });
        for (const player of players) {
          transaction.update(usersCollection.doc(player.playerId), player.updates);
        }
        transaction.create(
          adminsCollection.doc(adminUid).collection('roleSwapRequests').doc(receipt.requestId),
          receipt,
        );
      },
      writePlayer: (playerId, updates: AdminPlayerUpdates) => {
        transaction.update(usersCollection.doc(playerId), updates);
      },
      writeLogs: logs => transaction.update(configRef, { logs }),
    };
    return work(adminTransaction);
  }),
};

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'UNAUTHENTICATED':
      return 'unauthenticated';
    case 'PERMISSION_DENIED':
      return 'permission-denied';
    case 'INVALID_ARGUMENT':
      return 'invalid-argument';
    case 'PLAYER_NOT_FOUND':
    case 'CONFIG_NOT_FOUND':
      return 'not-found';
    case 'INVALID_PLAYER_STATE':
    case 'INVALID_TEAM':
    case 'INVALID_GAME_CONFIG':
    case 'INVALID_ROSTER':
    case 'INVALID_STATUS':
    case 'ROSTER_TOO_LARGE':
      return 'failed-precondition';
    default:
      return 'internal';
  }
}

function toHttpsError(error: unknown, operation: string, uid: string): HttpsError {
  if (error instanceof AdminGameStateServiceError) {
    return new HttpsError(callableCode(error.reason), error.reason, { reason: error.reason });
  }
  logger.error(`${operation} failed unexpectedly.`, { uid, error });
  return new HttpsError('internal', 'Admin action failed.', { reason: 'PERSISTENCE_ERROR' });
}

export const swapTeamRoles = onCall(
  { region: 'asia-northeast1' },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication is required.', {
        reason: 'UNAUTHENTICATED',
      });
    }
    try {
      return await swapTeamRolesForAdmin(
        request.auth.uid,
        request.data,
        adminGameStateStore,
        { now: Date.now, createLogId: randomUUID },
      );
    } catch (error) {
      throw toHttpsError(error, 'Role Swap', request.auth.uid);
    }
  },
);

export const resumePlayer = onCall(
  { region: 'asia-northeast1' },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication is required.', {
        reason: 'UNAUTHENTICATED',
      });
    }
    try {
      return await resumePlayerForAdmin(
        request.auth.uid,
        request.data,
        adminGameStateStore,
        { now: Date.now, createLogId: randomUUID },
      );
    } catch (error) {
      throw toHttpsError(error, 'Player Resume', request.auth.uid);
    }
  },
);
