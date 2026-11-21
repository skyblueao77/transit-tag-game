export type PlayerUnsubscribe = () => void;

export interface DifferentialPlayerSubscriber {
  setPlayerIds: (playerIds: readonly string[]) => void;
  dispose: () => void;
}

export interface CreateDifferentialPlayerSubscriberOptions<TValue> {
  subscribePlayer: (
    playerId: string,
    onNext: (value: TValue | null) => void,
    onFailure: (error: Error & { code?: string }) => void,
  ) => PlayerUnsubscribe;
  onPublish: (values: ReadonlyMap<string, TValue>) => void;
  onError: (error: Error) => void;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 15000;

/**
 * プレイヤーID集合の差分に応じて個別購読を追加・維持・解除する汎用サブスクライバー。
 */
export function createDifferentialPlayerSubscriber<TValue>({
  subscribePlayer,
  onPublish,
  onError,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
}: CreateDifferentialPlayerSubscriberOptions<TValue>): DifferentialPlayerSubscriber {
  let active = true;
  let desiredIds = new Set<string>();
  const values = new Map<string, TValue>();
  const subscriptions = new Map<string, PlayerUnsubscribe>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryAttempts = new Map<string, number>();

  const publish = () => {
    if (!active) return;
    onPublish(values);
  };

  const clearRetryTimer = (playerId: string) => {
    const timer = retryTimers.get(playerId);
    if (timer !== undefined) {
      clearTimeout(timer);
      retryTimers.delete(playerId);
    }
  };

  const scheduleRetry = (playerId: string) => {
    if (!active || !desiredIds.has(playerId) || retryTimers.has(playerId)) return;
    const attempt = retryAttempts.get(playerId) ?? 0;
    retryAttempts.set(playerId, attempt + 1);
    const delayMs = Math.min(maxRetryDelayMs, retryBaseDelayMs * 2 ** attempt);
    const timer = setTimeout(() => {
      retryTimers.delete(playerId);
      if (!active || !desiredIds.has(playerId) || subscriptions.has(playerId)) {
        return;
      }
      attachSubscription(playerId);
    }, delayMs);
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref?.unref === 'function') {
      maybeUnref.unref();
    }
    retryTimers.set(playerId, timer);
  };

  const attachSubscription = (playerId: string) => {
    if (!active || !desiredIds.has(playerId) || subscriptions.has(playerId)) return;
    clearRetryTimer(playerId);
    let failedSynchronously = false;
    const unsubscribe = subscribePlayer(
      playerId,
      value => {
        if (!active) return;
        retryAttempts.delete(playerId);
        clearRetryTimer(playerId);
        if (value !== null) values.set(playerId, value);
        else values.delete(playerId);
        publish();
      },
      error => {
        failedSynchronously = true;
        subscriptions.delete(playerId);
        values.delete(playerId);
        publish();
        if (!active) return;
        if (error.code === 'permission-denied') {
          scheduleRetry(playerId);
          return;
        }
        clearRetryTimer(playerId);
        retryAttempts.delete(playerId);
        onError(error);
      },
    );
    if (failedSynchronously || !active || !desiredIds.has(playerId)) {
      unsubscribe();
      return;
    }
    subscriptions.set(playerId, unsubscribe);
  };

  const setPlayerIds = (playerIds: readonly string[]) => {
    if (!active) return;
    const nextIds = new Set(playerIds);
    desiredIds = nextIds;
    let removedAny = false;

    for (const [playerId, unsubscribe] of subscriptions.entries()) {
      if (!nextIds.has(playerId)) {
        unsubscribe();
        subscriptions.delete(playerId);
        clearRetryTimer(playerId);
        retryAttempts.delete(playerId);
        if (values.delete(playerId)) {
          removedAny = true;
        }
      }
    }

    for (const playerId of Array.from(retryTimers.keys())) {
      if (!nextIds.has(playerId)) {
        clearRetryTimer(playerId);
        retryAttempts.delete(playerId);
      }
    }
    for (const playerId of Array.from(retryAttempts.keys())) {
      if (!nextIds.has(playerId)) {
        retryAttempts.delete(playerId);
      }
    }

    for (const playerId of nextIds) {
      if (subscriptions.has(playerId)) continue;
      attachSubscription(playerId);
    }

    if (removedAny || subscriptions.size === 0) {
      publish();
    }
  };

  const dispose = () => {
    active = false;
    desiredIds.clear();
    for (const unsubscribe of subscriptions.values()) {
      unsubscribe();
    }
    subscriptions.clear();
    for (const timer of retryTimers.values()) {
      clearTimeout(timer);
    }
    retryTimers.clear();
    retryAttempts.clear();
    values.clear();
  };

  return { setPlayerIds, dispose };
}
