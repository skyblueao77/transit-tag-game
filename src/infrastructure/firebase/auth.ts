import {
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebaseClient';

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

export async function signInAdmin(
  email: string,
  password: string,
): Promise<boolean> {
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

export async function signOutCurrentUser(): Promise<void> {
  await signOut(auth);
}
