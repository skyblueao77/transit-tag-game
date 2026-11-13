import { useEffect } from 'react';
import { resumeWaiting } from '../application';
import { firebaseWaitingGateway } from '../infrastructure/firebase/waitingActions';

interface UseWaitingAutoResumeParams {
  isOnline: boolean;
  status: string | undefined;
  waitingUntil: number | undefined;
  gameSessionId: string | undefined;
}

/**
 * 待機モードの自動復帰（Cloud Functions Cron不要化: Sparkプラン対応）。
 * オフライン時は無駄な5秒間隔リトライを抑制し、オンライン復帰時に再開する。
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
    let timer: ReturnType<typeof setTimeout>;

    const attempt = (delay: number) => {
      timer = setTimeout(async () => {
        if (cancelled || !navigator.onLine) return;
        if (!gameSessionId) return;
        const result = await resumeWaiting({ expectedSessionId: gameSessionId }, firebaseWaitingGateway);
        if (!cancelled && navigator.onLine && result.ok === false) {
          console.warn('Waiting resume retry scheduled:', result.reason);
          attempt(5000);
        }
      }, Math.max(0, delay));
    };

    attempt(waitingUntil - Date.now());
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOnline, status, waitingUntil, gameSessionId]);
}
