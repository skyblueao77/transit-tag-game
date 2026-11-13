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
}

/**
 * プレイヤーID集合の差分に応じて個別購読を追加・維持・解除する汎用サブスクライバー。
 */
export function createDifferentialPlayerSubscriber<TValue>({
  subscribePlayer,
  onPublish,
  onError,
}: CreateDifferentialPlayerSubscriberOptions<TValue>): DifferentialPlayerSubscriber {
  let active = true;
  const values = new Map<string, TValue>();
  const subscriptions = new Map<string, PlayerUnsubscribe>();

  const publish = () => {
    if (!active) return;
    onPublish(values);
  };

  const setPlayerIds = (playerIds: readonly string[]) => {
    if (!active) return;
    const nextIds = new Set(playerIds);
    let removedAny = false;

    for (const [playerId, unsubscribe] of subscriptions.entries()) {
      if (!nextIds.has(playerId)) {
        unsubscribe();
        subscriptions.delete(playerId);
        if (values.delete(playerId)) {
          removedAny = true;
        }
      }
    }

    for (const playerId of nextIds) {
      if (subscriptions.has(playerId)) continue;
      const unsubscribe = subscribePlayer(
        playerId,
        value => {
          if (value !== null) values.set(playerId, value);
          else values.delete(playerId);
          publish();
        },
        error => {
          values.delete(playerId);
          publish();
          if (error.code !== 'permission-denied') {
            onError(error);
          }
        },
      );
      subscriptions.set(playerId, unsubscribe);
    }

    if (removedAny || subscriptions.size === 0) {
      publish();
    }
  };

  const dispose = () => {
    active = false;
    for (const unsubscribe of subscriptions.values()) {
      unsubscribe();
    }
    subscriptions.clear();
    values.clear();
  };

  return { setPlayerIds, dispose };
}
