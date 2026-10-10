import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { AdminPhaseServiceError, transitionGamePhaseForAdmin } from './adminPhaseService';
import type { AdminPhaseStore, AdminPhaseTransaction, AdminPhaseReceipt } from './adminPhaseService';

if (getApps().length === 0) { const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT; if (projectId) initializeApp({ projectId }); else initializeApp(); }
const firestore = getFirestore();
const admins = firestore.collection('admins');
const configRef = firestore.doc('game_config/current');
const store: AdminPhaseStore = { runTransaction: work => firestore.runTransaction(transaction => work({
  readAdmin: async uid => (await transaction.get(admins.doc(uid))).exists,
  readReceipt: async (uid, requestId) => { const s = await transaction.get(admins.doc(uid).collection('phaseTransitionRequests').doc(requestId)); return s.exists ? s.data() ?? null : null; },
  readConfig: async () => { const s = await transaction.get(configRef); return s.exists ? s.data() ?? null : null; },
  readMission: async id => { const s = await transaction.get(firestore.collection('missions').doc(id)); return s.exists ? s.data() ?? null : null; },
  writeTransition: (uid, requestId, config, receipt: AdminPhaseReceipt) => { transaction.update(configRef, config as never); transaction.create(admins.doc(uid).collection('phaseTransitionRequests').doc(requestId), receipt); },
})) };
function code(reason: string): HttpsError['code'] { switch (reason) {
  case 'UNAUTHENTICATED': return 'unauthenticated'; case 'PERMISSION_DENIED': return 'permission-denied'; case 'INVALID_ARGUMENT': return 'invalid-argument';
  case 'CONFIG_NOT_FOUND': case 'FINAL_MISSION_NOT_FOUND': return 'not-found'; case 'INVALID_CONFIG': case 'TRANSITION_NOT_ALLOWED': return 'failed-precondition'; default: return 'internal';
} }
export const transitionGamePhase = onCall({ region: 'asia-northeast1' }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication is required.', { reason: 'UNAUTHENTICATED' });
  try { return await transitionGamePhaseForAdmin(request.auth.uid, request.data, store, { now: Date.now, random: Math.random, createId: randomUUID }); }
  catch (error) {
    if (error instanceof AdminPhaseServiceError) throw new HttpsError(code(error.reason), error.reason, { reason: error.reason });
    logger.error('Phase transition failed unexpectedly.', { uid: request.auth.uid, error });
    throw new HttpsError('internal', 'Admin action failed.', { reason: 'PERSISTENCE_ERROR' });
  }
});
