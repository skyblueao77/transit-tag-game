import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  processWaitingLifecycle,
  resumeWaitingForPlayer,
  startWaitingForPlayer,
  WaitingServiceError,
} from './waitingService';
import type {
  WaitingStore,
  WaitingTransaction,
  WaitingRuntime,
  WaitingPlayerUpdates,
} from './waitingService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const usersCollection = firestore.collection('users');
const configRef = firestore.doc('game_config/current');

const waitingStore: WaitingStore = {
  runTransaction: work => firestore.runTransaction(async transaction => {
    const waitingTransaction: WaitingTransaction = {
      readPlayer: async uid => {
        const snapshot = await transaction.get(usersCollection.doc(uid));
        return snapshot.exists
          ? { id: snapshot.id, data: snapshot.data() ?? {} }
          : null;
      },
      readGameConfig: async () => {
        const snapshot = await transaction.get(configRef);
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      writePlayer: (uid: string, updates: WaitingPlayerUpdates) => transaction.update(usersCollection.doc(uid), updates),
      writeLogs: logs => transaction.update(configRef, { logs }),
    };
    return work(waitingTransaction);
  }),
  listParticipantIds: async () => {
    const snapshot = await usersCollection.where('team', 'in', ['A', 'B']).get();
    return snapshot.docs.map(document => document.id);
  },
};

const runtime: WaitingRuntime = { now: Date.now, createLogId: randomUUID };

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'INVALID_ARGUMENT':
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

function requireEmptyRequest(data: unknown): void {
  if (data === null
    || typeof data !== 'object'
    || Array.isArray(data)
    || Object.keys(data).length !== 0) {
    throw new HttpsError('invalid-argument', 'Expected an empty request.', {
      reason: 'INVALID_ARGUMENT',
    });
  }
}

export const startWaiting = onCall(
  { region: 'asia-northeast1' },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication is required.', {
        reason: 'UNAUTHENTICATED',
      });
    }
    requireEmptyRequest(request.data);

    try {
      return await startWaitingForPlayer(request.auth.uid, waitingStore, runtime);
    } catch (error) {
      if (error instanceof WaitingServiceError) {
        throw new HttpsError(callableCode(error.reason), error.reason, { reason: error.reason });
      }
      logger.error('Manual Waiting failed unexpectedly.', { uid: request.auth.uid, error });
      throw new HttpsError('internal', 'Waiting could not be started.', {
        reason: 'PERSISTENCE_ERROR',
      });
    }
  },
);

export const resumeWaiting = onCall(
  { region: 'asia-northeast1' },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication is required.', {
        reason: 'UNAUTHENTICATED',
      });
    }
    requireEmptyRequest(request.data);

    try {
      return await resumeWaitingForPlayer(request.auth.uid, waitingStore, runtime);
    } catch (error) {
      if (error instanceof WaitingServiceError) {
        throw new HttpsError(callableCode(error.reason), error.reason, { reason: error.reason });
      }
      logger.error('Waiting resume failed unexpectedly.', { uid: request.auth.uid, error });
      throw new HttpsError('internal', 'Waiting could not be resumed.', {
        reason: 'PERSISTENCE_ERROR',
      });
    }
  },
);

export const processWaitingLifecycleSchedule = onSchedule(
  { schedule: 'every 1 minutes', region: 'asia-northeast1' },
  async () => {
    try {
      const result = await processWaitingLifecycle(waitingStore, runtime);
      const routineSkips = new Set([
        'NOT_EXPIRED',
        'NOT_ACTIVE',
        'NO_SHINKANSEN_START',
        'INVALID_SHINKANSEN_START',
        'SHINKANSEN_LIMIT_NOT_REACHED',
        'PHASE',
      ]);
      for (const skipped of result.skippedPlayers) {
        if (!routineSkips.has(skipped.reason)) {
          logger.warn('Waiting lifecycle skipped an invalid Player state.', skipped);
        }
      }
      logger.info('Waiting lifecycle scan completed.', result);
    } catch (error) {
      logger.error('Waiting lifecycle scan failed.', { error });
      throw error;
    }
  },
);
