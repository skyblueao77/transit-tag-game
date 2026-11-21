import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '../../types';
import {
  getCurrentAuthUserId,
  subscribeAuthUserId,
  subscribeCurrentAuthUserAdmin,
} from '../infrastructure/firebase/auth';
import {
  subscribeCurrentPlayer,
} from '../infrastructure/firebase/subscriptions';

export interface UseAuthUserResult {
  authUserId: string | null;
  authReady: boolean;
  currentUser: User | null;
  isAuthAdmin: boolean;
  userLoading: boolean;
  initialLoading: boolean;
  setCurrentUser: React.Dispatch<React.SetStateAction<User | null>>;
}

export function useAuthUser(): UseAuthUserResult {
  const [authUserId, setAuthUserId] = useState<string | null>(getCurrentAuthUserId);
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthAdmin, setIsAuthAdmin] = useState(false);
  const [userLoading, setUserLoading] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const prevAuthUserIdRef = useRef<string | null>(authUserId);
  const hasConfirmedUserRef = useRef(false);

  const setCurrentUserConfirmed = useCallback<React.Dispatch<React.SetStateAction<User | null>>>(
    action => {
      setCurrentUser(prev => {
        const next = typeof action === 'function' ? action(prev) : action;
        hasConfirmedUserRef.current = next !== null;
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    return subscribeAuthUserId(uid => {
      const prevUid = prevAuthUserIdRef.current;
      prevAuthUserIdRef.current = uid;
      setAuthUserId(uid);
      setAuthReady(true);
      if (!uid) {
        hasConfirmedUserRef.current = false;
        setCurrentUser(null);
        setIsAuthAdmin(false);
        setUserLoading(false);
        setInitialLoading(false);
      } else if (uid !== prevUid) {
        hasConfirmedUserRef.current = false;
        setUserLoading(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!authUserId) {
      hasConfirmedUserRef.current = false;
      setIsAuthAdmin(false);
      return;
    }

    hasConfirmedUserRef.current = false;

    const unsubscribeAdmin = subscribeCurrentAuthUserAdmin(
      authUserId,
      isAdmin => {
        setIsAuthAdmin(isAdmin);
      },
      () => {
        setIsAuthAdmin(false);
      },
    );

    const unsubscribe = subscribeCurrentPlayer(
      authUserId,
      (player, meta) => {
        if (player && meta?.hasPendingWrites && !hasConfirmedUserRef.current) {
          return;
        }
        hasConfirmedUserRef.current = Boolean(player);
        setCurrentUser(player);
        setUserLoading(false);
        setInitialLoading(false);
      },
      error => {
        console.error('Error fetching current user data:', error);
        hasConfirmedUserRef.current = false;
        setCurrentUser(null);
        setUserLoading(false);
        setInitialLoading(false);
      },
    );

    return () => {
      unsubscribeAdmin();
      unsubscribe();
    };
  }, [authUserId]);

  return {
    authUserId,
    authReady,
    currentUser,
    isAuthAdmin,
    userLoading,
    initialLoading,
    setCurrentUser: setCurrentUserConfirmed,
  };
}

export default useAuthUser;
