import { useState, useEffect } from 'react';
import type { User } from '../../types';
import {
  getCurrentAuthUserId,
  isCurrentAuthUserAdmin,
  subscribeAuthUserId,
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
  setCurrentUser: React.Dispatch<React.SetStateAction<User | null>>;
}

export function useAuthUser(): UseAuthUserResult {
  const [authUserId, setAuthUserId] = useState<string | null>(getCurrentAuthUserId);
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthAdmin, setIsAuthAdmin] = useState(false);
  const [userLoading, setUserLoading] = useState(true);

  useEffect(() => {
    return subscribeAuthUserId(uid => {
      setAuthUserId(uid);
      setAuthReady(true);
      if (!uid) {
        setCurrentUser(null);
        setIsAuthAdmin(false);
        setUserLoading(false);
      } else {
        setUserLoading(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!authUserId) {
      setIsAuthAdmin(false);
      return;
    }

    let cancelled = false;
    void isCurrentAuthUserAdmin()
      .then(isAdmin => {
        if (!cancelled) setIsAuthAdmin(isAdmin);
      })
      .catch(() => {
        if (!cancelled) setIsAuthAdmin(false);
      });

    const unsubscribe = subscribeCurrentPlayer(
      authUserId,
      player => {
        setCurrentUser(player);
        setUserLoading(false);
      },
      error => {
        console.error('Error fetching current user data:', error);
        setCurrentUser(null);
        setUserLoading(false);
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [authUserId]);

  return {
    authUserId,
    authReady,
    currentUser,
    isAuthAdmin,
    userLoading,
    setCurrentUser,
  };
}

export default useAuthUser;
