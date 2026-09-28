import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  activateInvincibilityForPlayer,
  InvincibilityServiceError,
} from './invincibilityService';
import type {
  InvincibilityStore,
  InvincibilityTransaction,
  InvincibilityWrite,
} from './invincibilityService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const usersCollection = firestore.collection('users');
const configRef = firestore.doc('game_config/current');

const invincibilityStore: InvincibilityStore = {
  runTransaction: work => firestore.runTransaction(async transaction => {
    const powerupTransaction: InvincibilityTransaction = {
      readPlayer: async uid => {
        const snapshot = await transaction.get(usersCollection.doc(uid));
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readGameConfig: async () => {
        const snapshot = await transaction.get(configRef);
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      writeInvincibility: (write: InvincibilityWrite) => {
        transaction.update(usersCollection.doc(write.playerId), {
          invincibleCards: write.invincibleCards,
          invincibleUntil: write.invincibleUntil,
        });
        transaction.update(configRef, { logs: write.logs });
      },
    };

    return work(powerupTransaction);
  }),
};

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'INVALID_ARGUMENT':
      return 'invalid-argument';
    case 'PLAYER_NOT_FOUND':
    case 'CONFIG_NOT_FOUND':
      return 'not-found';
    case 'INVALID_PLAYER_STATE':
    case 'INVALID_GAME_CONFIG':
    case 'POWERUP_NOT_ALLOWED':
    case 'WRONG_ROLE':
    case 'NO_CARDS':
    case 'ALREADY_ACTIVE':
      return 'failed-precondition';
    default:
      return 'internal';
  }
}

export const activateInvincibility = onCall(
  { region: 'asia-northeast1' },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication is required.', {
        reason: 'UNAUTHENTICATED',
      });
    }

    const data: unknown = request.data;
    if (data === null
      || typeof data !== 'object'
      || Array.isArray(data)
      || Object.keys(data).length !== 0) {
      throw new HttpsError('invalid-argument', 'Expected an empty request.', {
        reason: 'INVALID_ARGUMENT',
      });
    }

    const uid = request.auth.uid;
    try {
      return await activateInvincibilityForPlayer(
        uid,
        invincibilityStore,
        { now: Date.now, createLogId: randomUUID },
      );
    } catch (error) {
      if (error instanceof InvincibilityServiceError) {
        throw new HttpsError(callableCode(error.reason), error.reason, {
          reason: error.reason,
          ...(error.domainReason ? { domainReason: error.domainReason } : {}),
        });
      }

      logger.error('Invincibility activation failed unexpectedly.', { uid, error });
      throw new HttpsError('internal', 'Invincibility activation failed.', {
        reason: 'PERSISTENCE_ERROR',
      });
    }
  },
);
