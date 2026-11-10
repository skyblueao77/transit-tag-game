import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebaseClient';

/**
 * 初回管理者が既に初期化済みかどうかを確認します。
 */
export async function isAdminBootstrapCompleted(): Promise<boolean> {
  const bootstrapDoc = await getDoc(doc(db, 'system', 'admin_bootstrap'));
  return bootstrapDoc.exists();
}

/**
 * ユーザーIDをFirebase Auth用の内部ドメインアドレスに変換します。
 * 個人情報（実在のメールアドレス）を一切要求・収集せず、高いプライバシーと安全性を両立します。
 */
export function toSyntheticEmail(userId: string): string {
  const trimmed = userId.trim().toLowerCase();
  if (trimmed.includes('@')) return trimmed;
  const sanitized = trimmed.replace(/[^a-z0-9_.-]/g, '_');
  return `${sanitized || 'player'}@transit-tag.local`;
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

/**
 * 初回管理者アカウント作成（プログラミング・Firebase Console操作不要）。
 * 最初の1回のみ system/admin_bootstrap と admins/{uid} をアトミックに作成します。
 */
export async function setupInitialAdmin(
  identifier: string,
  password: string,
): Promise<boolean> {
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD_TOO_SHORT');
  }

  const isCompleted = await isAdminBootstrapCompleted();
  if (isCompleted) {
    throw new Error('ADMIN_ALREADY_INITIALIZED');
  }

  const email = toSyntheticEmail(identifier);
  let uid: string;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    uid = cred.user.uid;
  } catch (err: unknown) {
    const errorCode = (err as { code?: string })?.code;
    if (errorCode === 'auth/email-already-in-use') {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      uid = cred.user.uid;
    } else {
      throw err;
    }
  }

  // アトミックに初期管理者ブートストラップと管理者ドキュメントを作成
  const batch = writeBatch(db);
  batch.set(doc(db, 'system', 'admin_bootstrap'), {
    initializedBy: uid,
    initializedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'admins', uid), {
    role: 'admin',
    createdAt: serverTimestamp(),
  });
  await batch.commit();

  return true;
}

export async function isCurrentAuthUserAdmin(): Promise<boolean> {
  const uid = getCurrentAuthUserId();
  if (!uid) return false;
  return (await getDoc(doc(db, 'admins', uid))).exists();
}

export async function signOutCurrentUser(): Promise<void> {
  await signOut(auth);
}
