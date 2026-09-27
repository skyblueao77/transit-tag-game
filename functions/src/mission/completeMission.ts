import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import {
  completeMissionForPlayer,
  MissionServiceError,
} from './missionService';
import type {
  MissionCompletionWrite,
  MissionStore,
  MissionTransaction,
} from './missionService';

if (getApps().length === 0) {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) initializeApp({ projectId });
  else initializeApp();
}

const firestore = getFirestore();

const missionStore: MissionStore = {
  runTransaction: work => firestore.runTransaction(async transaction => {
    const missionTransaction: MissionTransaction = {
      readPlayer: async uid => {
        const snapshot = await transaction.get(firestore.collection('users').doc(uid));
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readGameConfig: async () => {
        const snapshot = await transaction.get(firestore.doc('game_config/current'));
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readMission: async missionId => {
        const snapshot = await transaction.get(firestore.collection('missions').doc(missionId));
        return snapshot.exists ? snapshot.data() ?? null : null;
      },
      readCompletion: async completionId => {
        const snapshot = await transaction.get(
          firestore.collection('missionCompletions').doc(completionId),
        );
        return snapshot.exists;
      },
      writeMissionCompletion: (write: MissionCompletionWrite) => {
        transaction.create(
          firestore.collection('missionCompletions').doc(write.completionId),
          {
            ...write.completion,
            completedAt: FieldValue.serverTimestamp(),
          },
        );

        const playerRef = firestore.collection('users').doc(
          // completedBy is the Auth UID validated by the callable service.
          write.completion.completedBy,
        );
        const configRef = firestore.doc('game_config/current');
        const teamScoreField = write.completion.team === 'A' ? 'teamAScore' : 'teamBScore';

        transaction.update(playerRef, {
          score: write.playerScore,
          invincibleCards: write.invincibleCards,
        });
        transaction.update(configRef, {
          [teamScoreField]: write.teamScore,
          logs: write.logs,
        });
      },
    };

    return work(missionTransaction);
  }),
};

function callableCode(reason: string): HttpsError['code'] {
  switch (reason) {
    case 'INVALID_ARGUMENT':
      return 'invalid-argument';
    case 'PLAYER_NOT_FOUND':
    case 'MISSION_NOT_FOUND':
      return 'not-found';
    case 'ALREADY_COMPLETED':
      return 'already-exists';
    case 'PLAYER_NOT_ACTIVE':
    case 'INVALID_PLAYER_TEAM':
    case 'MISSION_NOT_ACTIVE':
    case 'MISSION_NOT_ALLOWED':
      return 'failed-precondition';
    default:
      return 'internal';
  }
}

export const completeMission = onCall(
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
      || !Object.prototype.hasOwnProperty.call(data, 'missionId')
    ) {
      throw new HttpsError('invalid-argument', 'Expected only a missionId.', {
        reason: 'INVALID_ARGUMENT',
      });
    }

    const missionId = (data as { missionId: unknown }).missionId;
    try {
      return await completeMissionForPlayer(
        request.auth.uid,
        missionId,
        missionStore,
        { random: Math.random, now: Date.now },
      );
    } catch (error) {
      if (error instanceof MissionServiceError) {
        throw new HttpsError(callableCode(error.reason), error.reason, {
          reason: error.reason,
        });
      }

      logger.error('Mission completion failed unexpectedly.', {
        uid: request.auth.uid,
        missionId: typeof missionId === 'string' ? missionId : undefined,
        error,
      });
      throw new HttpsError('internal', 'Mission completion failed.', {
        reason: 'PERSISTENCE_ERROR',
      });
    }
  },
);
