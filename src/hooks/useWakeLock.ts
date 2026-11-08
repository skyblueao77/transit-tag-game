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

  const release = useCallback(async () => {
    if (sentinelRef.current) {
      try {
        await sentinelRef.current.release();
      } catch {
        // ignore release errors
      } finally {
        sentinelRef.current = null;
        setIsLocked(false);
      }
    }
  }, []);

  const request = useCallback(async () => {
    if (!isSupported || document.visibilityState !== 'visible') return;
    try {
      if (sentinelRef.current && !sentinelRef.current.released) return;
      const sentinel = await navigator.wakeLock.request('screen');
      sentinelRef.current = sentinel;
      setIsLocked(true);
      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null;
          setIsLocked(false);
        }
      });
    } catch {
      // Screen lock may be denied (low battery, user permissions, etc.)
      setIsLocked(false);
    }
  }, [isSupported]);

  useEffect(() => {
    if (!enabled) {
      void release();
      return;
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
