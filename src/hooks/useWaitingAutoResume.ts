import { useEffect } from 'react';
import { resumeWaiting } from '../application';
import { getServerNowMs, getServerTimeOffsetMs } from '../infrastructure/firebase/serverClock';
import { firebaseWaitingGateway } from '../infrastructure/firebase/waitingActions';

interface UseWaitingAutoResumeParams {
  isOnline: boolean;
  status: string | undefined;
  waitingUntil: number | undefined;
  gameSessionId: string | undefined;
}

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
    let timer: ReturnType<typeof setTimeout>;
    let attemptCount = 0;

    const attempt = (delay: number) => {
      timer = setTimeout(async () => {
        if (cancelled || !navigator.onLine) return;
        if (!gameSessionId) return;
        attemptCount += 1;
        const result = await resumeWaiting({ expectedSessionId: gameSessionId }, firebaseWaitingGateway);
        if (!cancelled && navigator.onLine && result.ok === false) {
          console.warn('Waiting resume retry scheduled:', result.reason);
          attempt(Math.min(30000, 5000 * attemptCount));
        }
      }, Math.max(0, delay));
    };

    const serverTimeOffset = getServerTimeOffsetMs();
    attempt(waitingUntil - getServerNowMs(Date.now() + serverTimeOffset - serverTimeOffset));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOnline, status, waitingUntil, gameSessionId]);
}
