import { useEffect } from 'react';
import { resumeWaiting } from '../application';
import { getServerNowMs } from '../infrastructure/firebase/serverClock';
import { firebaseWaitingGateway } from '../infrastructure/firebase/waitingActions';

interface UseWaitingAutoResumeParams {
  isOnline: boolean;
  status: string | undefined;
  waitingUntil: number | undefined;
  gameSessionId: string | undefined;
}

const MAX_AUTO_RESUME_ATTEMPTS = 12;

/**
 * 待機モードの自動復帰（Cloud Functions Cron不要化: Sparkプラン対応）。
 * オフライン時は無駄なリトライを抑制し、サーバー時刻オフセット同期済み時刻で再開する。
 */
export default function useWaitingAutoResume({
  isOnline,
  status,
  waitingUntil,
  gameSessionId,
}: UseWaitingAutoResumeParams): void {
  useEffect(() => {
    if (!isOnline || status !== 'WAITING' || !waitingUntil) return;

    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attemptCount = 0;

    const attempt = (delay: number) => {
      if (timer !== undefined) clearTimeout(timer);
      if (cancelled) return;
      timer = setTimeout(async () => {
        if (cancelled || !navigator.onLine || !gameSessionId || inFlight) return;
        inFlight = true;
        attemptCount += 1;
        try {
          const result = await resumeWaiting({ expectedSessionId: gameSessionId }, firebaseWaitingGateway);
          if (cancelled || !navigator.onLine) return;
          if (result.ok === false) {
            if (attemptCount < MAX_AUTO_RESUME_ATTEMPTS) {
              console.warn('Waiting resume retry scheduled:', result.reason);
              attempt(Math.min(30000, 5000 * attemptCount));
            }
          } else if (!result.resumed && attemptCount < MAX_AUTO_RESUME_ATTEMPTS) {
            attempt(Math.min(15000, 2000 * attemptCount));
          }
        } finally {
          inFlight = false;
        }
      }, Math.max(0, delay));
    };

    const handleResumeEvent = () => {
      if (cancelled || !navigator.onLine) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      attemptCount = 0;
      attempt(waitingUntil - getServerNowMs());
    };

    const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
    if (hasDom) {
      document.addEventListener('visibilitychange', handleResumeEvent);
      window.addEventListener('pageshow', handleResumeEvent);
      window.addEventListener('online', handleResumeEvent);
    }

    attempt(waitingUntil - getServerNowMs());
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (hasDom) {
        document.removeEventListener('visibilitychange', handleResumeEvent);
        window.removeEventListener('pageshow', handleResumeEvent);
        window.removeEventListener('online', handleResumeEvent);
      }
    };
  }, [isOnline, status, waitingUntil, gameSessionId]);
}
