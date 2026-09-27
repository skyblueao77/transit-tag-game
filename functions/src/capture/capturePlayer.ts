import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  capturePlayerForPlayer,
  CaptureServiceError,
} from './captureService';
import type {
  CaptureStore,
  CaptureTransaction,
  CaptureWrite,
} from './captureService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();
const usersCollection = firestore.collection('users');
const configRef = firestore.doc('game_config/current');

const captureStore: CaptureStore = {
  runTransaction: work => firestore.runTransaction(async transaction => {
    const captureTransaction: CaptureTransaction = {
      readGameConfig: async () => {
        const snapshot = await transaction.get(configRef);
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readUsers: async (captorId, targetId) => {
        const participantQuery = usersCollection.where('team', 'in', ['A', 'B']);
        const [participants, captor, target] = await Promise.all([
          transaction.get(participantQuery),
          transaction.get(usersCollection.doc(captorId)),
          transaction.get(usersCollection.doc(targetId)),
        ]);
        const documents = new Map<string, { id: string; data: Record<string, unknown> }>();
        for (const snapshot of participants.docs) {
          documents.set(snapshot.id, { id: snapshot.id, data: snapshot.data() });
        }
        if (captor.exists) {
          documents.set(captor.id, { id: captor.id, data: captor.data() ?? {} });
        }
        if (target.exists) {
          documents.set(target.id, { id: target.id, data: target.data() ?? {} });
        }
        return [...documents.values()];
      },
      writeCapture: (write: CaptureWrite) => {
        transaction.update(configRef, {
          teamARole: write.capture.teamRoles.teamARole,
          teamBRole: write.capture.teamRoles.teamBRole,
          nextRevealTime: write.capture.nextRevealTime,
          [write.teamScoreField]: FieldValue.increment(write.capture.reward.scoreDelta),
          logs: write.logs,
        });

        for (const change of write.capture.playerChanges) {
          const updates = {
            status: change.status,
            waitingUntil: change.waitingUntil,
            ...(change.invincibleUntil === undefined
              ? {}
              : { invincibleUntil: change.invincibleUntil }),
            ...(change.invincibleCardsDelta === 0
              ? {}
              : { invincibleCards: FieldValue.increment(change.invincibleCardsDelta) }),
          };
          transaction.update(usersCollection.doc(change.playerId), updates);
        }
      },
    };

    return work(captureTransaction);
  }),
};

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'INVALID_ARGUMENT':
      return 'invalid-argument';
    case 'PLAYER_NOT_FOUND':
    case 'TARGET_NOT_FOUND':
      return 'not-found';
    case 'INVALID_CAPTOR_TEAM':
    case 'INVALID_TARGET_TEAM':
    case 'GAME_CONFIG_NOT_FOUND':
    case 'INVALID_GAME_STATE':
    case 'CAPTURE_REJECTED':
      return 'failed-precondition';
    default:
      return 'internal';
  }
}

export const capturePlayer = onCall(
  { region: 'asia-northeast1' },
  async request => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Authentication is required.', {
        reason: 'UNAUTHENTICATED',
      });
    }

    const data: unknown = request.data;
    if (
      data === null
      || typeof data !== 'object'
      || Array.isArray(data)
      || Object.keys(data).length !== 1
      || !Object.prototype.hasOwnProperty.call(data, 'targetId')
    ) {
      throw new HttpsError('invalid-argument', 'Expected only a targetId.', {
        reason: 'INVALID_ARGUMENT',
      });
    }

    const targetId = (data as { targetId: unknown }).targetId;
    try {
      return await capturePlayerForPlayer(
        request.auth.uid,
        targetId,
        captureStore,
        { now: Date.now, createLogId: randomUUID },
      );
    } catch (error) {
      if (error instanceof CaptureServiceError) {
        throw new HttpsError(callableCode(error.reason), error.reason, {
          reason: error.reason,
          ...(error.domainReason ? { domainReason: error.domainReason } : {}),
        });
      }

      logger.error('Capture failed unexpectedly.', {
        uid: request.auth.uid,
        targetId: typeof targetId === 'string' ? targetId : undefined,
        error,
      });
      throw new HttpsError('internal', 'Capture failed.', {
        reason: 'PERSISTENCE_ERROR',
      });
    }
  },
);
