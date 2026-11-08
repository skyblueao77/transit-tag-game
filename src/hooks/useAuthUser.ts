import { useState, useEffect, useRef } from 'react';
import type { User } from '../../types';
import {
  getCurrentAuthUserId,
  subscribeAuthUserId,
} from '../infrastructure/firebase/auth';
import {
  subscribeCurrentPlayer,
} from '../infrastructure/firebase/subscriptions';

export interface UseAuthUserResult {
  authUserId: string | null;
  authReady: boolean;
  currentUser: User | null;
  userLoading: boolean;
  setCurrentUser: React.Dispatch<React.SetStateAction<User | null>>;
}

export function useAuthUser(): UseAuthUserResult {
  const [authUserId, setAuthUserId] = useState<string | null>(getCurrentAuthUserId);
  const authUserIdRef = useRef(authUserId);
  const [authReady, setAuthReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [userLoading, setUserLoading] = useState(true);

  useEffect(() => {
    return subscribeAuthUserId(uid => {
      authUserIdRef.current = uid;
      setAuthUserId(uid);
      setAuthReady(true);
      if (!uid) {
        setCurrentUser(null);
        setUserLoading(false);
      } else {
        setUserLoading(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!authUserId) return;

    return subscribeCurrentPlayer(
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
  }, [authUserId]);

  return {
    authUserId,
    authReady,
    currentUser,
    userLoading,
    setCurrentUser,
  };
}

export default useAuthUser;
