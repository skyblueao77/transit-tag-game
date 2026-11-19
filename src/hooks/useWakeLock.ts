import { useEffect, useRef, useState, useCallback } from 'react';

export interface UseWakeLockResult {
  isSupported: boolean;
  isLocked: boolean;
  request: () => Promise<void>;
  release: () => Promise<void>;
}

/**
 * Custom hook to control Screen Wake Lock API.
 * Keeps the device display active during active gameplay (e.g. MapView).
 * Automatically releases lock when switching apps and re-acquires on return.
 */
export function useWakeLock(enabled: boolean = true): UseWakeLockResult {
  const isSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [isLocked, setIsLocked] = useState(false);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const mountedRef = useRef(true);
  const enabledRef = useRef(enabled);
  const requestEpochRef = useRef(0);
  enabledRef.current = enabled;

  const release = useCallback(async () => {
    requestEpochRef.current += 1;
    if (sentinelRef.current) {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      try {
        await sentinel.release();
      } catch {
        // ignore release errors
      } finally {
        if (mountedRef.current) {
          setIsLocked(false);
        }
      }
    } else if (mountedRef.current) {
      setIsLocked(false);
    }
  }, []);

  const request = useCallback(async () => {
    if (!isSupported || !enabledRef.current || !mountedRef.current || document.visibilityState !== 'visible') return;
    if (sentinelRef.current && !sentinelRef.current.released) return;
    const epoch = ++requestEpochRef.current;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (epoch !== requestEpochRef.current || !enabledRef.current || !mountedRef.current || document.visibilityState !== 'visible') {
        await sentinel.release().catch(() => {});
        return;
      }
      sentinelRef.current = sentinel;
      setIsLocked(true);
      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null;
          if (mountedRef.current) {
            setIsLocked(false);
          }
        }
      });
    } catch {
      // Screen lock may be denied (low battery, user permissions, etc.)
      if (mountedRef.current && epoch === requestEpochRef.current) {
        setIsLocked(false);
      }
    }
  }, [isSupported]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      void release();
      return () => {
        mountedRef.current = false;
      };
    }

    void request();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void request();
      } else {
        void release();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void release();
    };
  }, [enabled, request, release]);

  return {
    isSupported,
    isLocked,
    request,
    release,
  };
}

export default useWakeLock;
