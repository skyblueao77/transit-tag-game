import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { auth, db } from './firebaseClient';
import {
  isServerClockCalibrated,
  markServerTimestampWriteSent,
  recordConfirmedServerTimestamp,
} from './serverClock';

/**
 * ユーザーIDをFirebase Auth用の内部ドメインアドレスに変換します。
 * 個人情報（実在のメールアドレス）を一切要求・収集せず、高いプライバシーと安全性を両立します。
 */
export function toSyntheticEmail(userId: string): string {
  const trimmed = userId.trim().toLowerCase();
  if (trimmed.includes('@')) return trimmed;
  if (/^[a-z0-9_.-]+$/.test(trimmed)) {
    return `${trimmed}@transit-tag.local`;
  }
  const hex = Array.from(new TextEncoder().encode(trimmed))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `u_${hex}@transit-tag.local`;
}

export function getCurrentAuthUserId(): string | null {
  return auth.currentUser?.uid ?? null;
}

export function subscribeAuthUserId(
  callback: (uid: string | null) => void,
): () => void {
  return onAuthStateChanged(auth, user => callback(user?.uid ?? null));
}

export async function ensureAnonymousAuthUser(): Promise<string> {
  if (auth.currentUser) return auth.currentUser.uid;
  const credential = await signInAnonymously(auth);
  return credential.user.uid;
}

/**
 * 簡単なユーザーIDとパスワードで新規アカウントを作成します（メールアドレス不要）。
 */
export async function registerWithUserId(
  userId: string,
  password: string,
): Promise<string> {
  const email = toSyntheticEmail(userId);
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  return credential.user.uid;
}

/**
 * 簡単なユーザーIDとパスワードでログインします（メールアドレス不要）。
 */
export async function signInWithUserId(
  userId: string,
  password: string,
): Promise<string> {
  const email = toSyntheticEmail(userId);
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user.uid;
}

/**
 * 管理者ログイン（管理者のユーザーIDまたはメールアドレスとパスワード）。
 */
export async function signInAdmin(
  identifier: string,
  password: string,
): Promise<boolean> {
  const email = toSyntheticEmail(identifier);
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const adminSnapshot = await getDoc(doc(db, 'admins', credential.user.uid));
  if (adminSnapshot.exists()) return true;

  await signOut(auth);
  return false;
}

export async function isCurrentAuthUserAdmin(): Promise<boolean> {
  const uid = getCurrentAuthUserId();
  if (!uid) return false;
  return (await getDoc(doc(db, 'admins', uid))).exists();
}

export function subscribeCurrentAuthUserAdmin(
  uid: string,
  onValue: (isAdmin: boolean) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, 'admins', uid),
    snapshot => {
      onValue(snapshot.exists());
    },
    error => {
      onError?.(error);
    },
  );
}

export async function calibrateAdminServerClock(): Promise<void> {
  if (isServerClockCalibrated()) return;
  const uid = getCurrentAuthUserId();
  if (!uid) return;
  try {
    const probeRef = doc(db, 'admins', uid, 'clockSync', 'probe');
    markServerTimestampWriteSent();
    await setDoc(probeRef, { updatedAt: serverTimestamp() });
    const snap = await getDocFromServer(probeRef);
    const updatedAt = snap.data()?.updatedAt;
    if (updatedAt && typeof updatedAt === 'object' && 'toMillis' in updatedAt && typeof updatedAt.toMillis === 'function') {
      recordConfirmedServerTimestamp(updatedAt.toMillis(), {
        hasPendingWrites: snap.metadata.hasPendingWrites,
        fromCache: snap.metadata.fromCache,
      });
    }
  } catch (error) {
    console.warn('Admin server clock calibration skipped:', error);
  }
}

export async function signOutCurrentUser(): Promise<void> {
  await signOut(auth);
}
