import { deleteUser } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import type { User } from '../../../types';
import { TEAM_COLORS } from '../../../constants';
import { validateGameSession } from '../../game/gameSession';
import { auth, db } from './firebaseClient';
import { registerWithUserId, signInWithUserId, signOutCurrentUser } from './auth';
import { firebasePrivateLocationStore } from './locationStores';
import { createPlayerWithPrivateLocation } from './playerStore';
import { mapUserDocument } from './snapshotMappers';

export type RegisterPlayerResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'SESSION_NOT_INITIALIZED' };

export type LoginPlayerResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'PLAYER_NOT_FOUND' | 'SESSION_MISMATCH' };

export async function resolveActiveGameSessionId(
  fallbackSessionId?: string,
): Promise<string | null> {
  if (typeof fallbackSessionId === 'string' && fallbackSessionId.trim().length > 0) {
    return fallbackSessionId;
  }
  const configSnap = await getDoc(doc(db, 'game_config', 'current'));
  const configData = configSnap.data();
  const validation = validateGameSession(configData ?? null);
  if (!validation.valid) {
    return null;
  }
  return validation.session.gameSessionId;
}

export async function registerPlayerAccount(input: {
  userId: string;
  password: string;
  name: string;
  team: 'A' | 'B';
  location: { latitude: number; longitude: number };
  fallbackSessionId?: string;
}): Promise<RegisterPlayerResult> {
  const activeSessionId = await resolveActiveGameSessionId(input.fallbackSessionId);
  if (!activeSessionId) {
    return { ok: false, reason: 'SESSION_NOT_INITIALIZED' };
  }

  let createdAuthUid: string | null = null;
  try {
    const id = await registerWithUserId(input.userId, input.password);
    createdAuthUid = id;

    const color: string = input.team === 'A' ? TEAM_COLORS[0] : TEAM_COLORS[1];
    const newUser: User = {
      id,
      name: input.name.trim(),
      role: 'RUNNER',
      team: input.team,
      color,
      score: 0,
      status: 'ACTIVE',
      gameSessionId: activeSessionId,
      invincibleCards: 0,
    };

    await createPlayerWithPrivateLocation(newUser, input.location, activeSessionId);
    createdAuthUid = null;
    return { ok: true, user: newUser };
  } catch (err) {
    if (createdAuthUid && auth.currentUser?.uid === createdAuthUid) {
      await deleteUser(auth.currentUser).catch(() => {});
    }
    throw err;
  }
}

export async function loginPlayerAccount(input: {
  userId: string;
  password: string;
  currentLocation?: { latitude: number; longitude: number } | null;
  fallbackSessionId?: string;
}): Promise<LoginPlayerResult> {
  const uid = await signInWithUserId(input.userId, input.password);
  const userSnap = await getDoc(doc(db, 'users', uid));

  if (!userSnap.exists()) {
    await signOutCurrentUser().catch(() => {});
    return { ok: false, reason: 'PLAYER_NOT_FOUND' };
  }

  const existingUser = mapUserDocument(userSnap.id, userSnap.data());
  const activeSessionId = await resolveActiveGameSessionId(input.fallbackSessionId).catch(() => null);
  if (
    activeSessionId
    && existingUser.team !== 'ADMIN'
    && existingUser.gameSessionId !== activeSessionId
  ) {
    await signOutCurrentUser().catch(() => {});
    return { ok: false, reason: 'SESSION_MISMATCH' };
  }

  const targetSession = activeSessionId || existingUser.gameSessionId;
  // GPS測位が完了している場合のみ現在地を更新（未測位の東京駅初期値で上書きしない）
  if (input.currentLocation && targetSession) {
    try {
      await firebasePrivateLocationStore.save(uid, input.currentLocation, targetSession);
    } catch (locErr) {
      console.warn('Failed to update location on resume:', locErr);
    }
  }

  return { ok: true, user: existingUser };
}
