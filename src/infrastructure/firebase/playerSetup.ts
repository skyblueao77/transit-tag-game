import { deleteUser } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import type { User } from '../../../types';
import { TEAM_COLORS } from '../../../constants';
import { validateGameSession } from '../../game/gameSession';
import { truncateToUtf8Bytes } from '../../game/utf8';
import { auth, db } from './firebaseClient';
import { registerWithUserId, signInWithUserId, signOutCurrentUser } from './auth';
import { firebasePrivateLocationStore } from './locationStores';
import { createPlayerWithPrivateLocation } from './playerStore';
import { mapUserDocument } from './snapshotMappers';

export type RegisterPlayerResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'SESSION_NOT_INITIALIZED' | 'INVALID_JOIN_CODE' | 'JOIN_CODE_INACTIVE' | 'REGISTRATION_CLOSED' };

export type LoginPlayerResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'PLAYER_NOT_FOUND' | 'SESSION_MISMATCH' };

const JOIN_CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

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

async function rollbackAuthState(createdAuthUid: string | null, signedInExistingUid: string | null): Promise<void> {
  if (createdAuthUid && auth.currentUser?.uid === createdAuthUid) {
    await deleteUser(auth.currentUser).catch(() => {});
  } else if (signedInExistingUid && auth.currentUser?.uid === signedInExistingUid) {
    await signOutCurrentUser().catch(() => {});
  }
}

export async function registerPlayerAccount(input: {
  userId: string;
  password: string;
  name: string;
  team: 'A' | 'B';
  joinCode: string;
  location: { latitude: number; longitude: number };
  fallbackSessionId?: string;
}): Promise<RegisterPlayerResult> {
  const normalizedName = truncateToUtf8Bytes(input.name.trim(), 80);
  if (!normalizedName) {
    throw new Error('INVALID_ARGUMENT');
  }

  const normalizedJoinCode = typeof input.joinCode === 'string' ? input.joinCode.trim() : '';
  if (!JOIN_CODE_PATTERN.test(normalizedJoinCode)) {
    return { ok: false, reason: 'INVALID_JOIN_CODE' };
  }

  let createdAuthUid: string | null = null;
  let signedInExistingUid: string | null = null;
  try {
    let id: string;
    try {
      id = await registerWithUserId(input.userId, input.password);
      createdAuthUid = id;
    } catch (authErr: unknown) {
      const code = (authErr as { code?: string })?.code;
      if (code !== 'auth/email-already-in-use') {
        throw authErr;
      }
      // 削除済みプレイヤー等で Auth ユーザーだけ残っている場合、パスワードが一致し Firestore 側に存在しなければ再利用する
      let existingUid: string;
      try {
        existingUid = await signInWithUserId(input.userId, input.password);
        signedInExistingUid = existingUid;
      } catch (signInErr: unknown) {
        const signInCode = (signInErr as { code?: string })?.code;
        if (signInCode === 'auth/wrong-password' || signInCode === 'auth/invalid-credential') {
          throw authErr;
        }
        throw signInErr;
      }
      const [userSnap, adminSnap] = await Promise.all([
        getDoc(doc(db, 'users', existingUid)),
        getDoc(doc(db, 'admins', existingUid)),
      ]);
      if (adminSnap.exists() || userSnap.exists()) {
        await signOutCurrentUser().catch(() => {});
        signedInExistingUid = null;
        throw authErr;
      }
      id = existingUid;
    }

    // Firestore ルールで joinCodes/{code} の読み取りにはパスワード認証が必須のため、認証完了後に検証する
    const joinCodeSnap = await getDoc(doc(db, 'joinCodes', normalizedJoinCode));
    if (!joinCodeSnap.exists()) {
      await rollbackAuthState(createdAuthUid, signedInExistingUid);
      createdAuthUid = null;
      signedInExistingUid = null;
      return { ok: false, reason: 'INVALID_JOIN_CODE' };
    }
    const joinCodeData = joinCodeSnap.data();
    const joinSessionId = typeof joinCodeData.gameSessionId === 'string' ? joinCodeData.gameSessionId : '';
    if (joinCodeData.active !== true || joinSessionId.length === 0) {
      await rollbackAuthState(createdAuthUid, signedInExistingUid);
      createdAuthUid = null;
      signedInExistingUid = null;
      return { ok: false, reason: 'JOIN_CODE_INACTIVE' };
    }

    const activeSessionId = await resolveActiveGameSessionId(joinSessionId);
    if (!activeSessionId) {
      await rollbackAuthState(createdAuthUid, signedInExistingUid);
      createdAuthUid = null;
      signedInExistingUid = null;
      return { ok: false, reason: 'SESSION_NOT_INITIALIZED' };
    }

    const color: string = input.team === 'A' ? TEAM_COLORS[0] : TEAM_COLORS[1];
    const newUser: User = {
      id,
      name: normalizedName,
      role: 'RUNNER',
      team: input.team,
      color,
      score: 0,
      status: 'ACTIVE',
      gameSessionId: activeSessionId,
      invincibleCards: 0,
      joinCode: normalizedJoinCode,
    };

    try {
      await createPlayerWithPrivateLocation(newUser, input.location, activeSessionId);
    } catch (createErr: unknown) {
      const errCode = (createErr as { code?: string })?.code;
      if (errCode === 'permission-denied') {
        await rollbackAuthState(createdAuthUid, signedInExistingUid);
        createdAuthUid = null;
        signedInExistingUid = null;
        return { ok: false, reason: 'REGISTRATION_CLOSED' };
      }
      throw createErr;
    }
    createdAuthUid = null;
    signedInExistingUid = null;
    return { ok: true, user: newUser };
  } catch (err) {
    await rollbackAuthState(createdAuthUid, signedInExistingUid);
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
  let activeSessionId: string | null = null;
  try {
    activeSessionId = await resolveActiveGameSessionId(input.fallbackSessionId);
  } catch (sessionErr: unknown) {
    const errCode = (sessionErr as { code?: string })?.code;
    if (errCode === 'permission-denied' && existingUser.team !== 'ADMIN') {
      // 旧セッションのプレイヤーは game_config/current の read ルールで拒否されるためセッション不一致として扱う
      await signOutCurrentUser().catch(() => {});
      return { ok: false, reason: 'SESSION_MISMATCH' };
    }
    activeSessionId = null;
  }
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
