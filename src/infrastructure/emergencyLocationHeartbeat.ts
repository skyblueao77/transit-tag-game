import type {
  UpdatePrivateLocationInput,
  UpdatePrivateLocationResult,
} from '../application/locationPorts';

export const EMERGENCY_LOCATION_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_LOCATION_ACCURACY_METERS = 400;

export interface EmergencyHeartbeatPosition {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
}

export interface EmergencyHeartbeatGeolocation {
  getCurrentPosition(
    success: (position: EmergencyHeartbeatPosition) => void,
    error?: (error: unknown) => void,
    options?: PositionOptions,
  ): unknown;
}

export interface EmergencyHeartbeatScheduler {
  setInterval(callback: () => void, delay: number): ReturnType<typeof globalThis.setInterval>;
  clearInterval(handle: ReturnType<typeof globalThis.setInterval>): void;
}

export interface EmergencyLocationHeartbeatInput {
  status: string | undefined;
  playerId: string | undefined;
  authUserId: string | null;
  geolocation: EmergencyHeartbeatGeolocation | null;
  updatePrivateLocation: (input: UpdatePrivateLocationInput) => Promise<UpdatePrivateLocationResult>;
  isCurrentPlayer: () => boolean;
  isOnline: () => boolean;
  scheduler?: EmergencyHeartbeatScheduler;
  onFailure?: (reason: unknown) => void;
}

const browserScheduler: EmergencyHeartbeatScheduler = {
  setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
  clearInterval: handle => globalThis.clearInterval(handle),
};

function isEligible(input: EmergencyLocationHeartbeatInput): input is EmergencyLocationHeartbeatInput & {
  playerId: string;
  authUserId: string;
  geolocation: EmergencyHeartbeatGeolocation;
} {
  return input.status === 'EMERGENCY'
    && typeof input.playerId === 'string'
    && input.playerId.length > 0
    && input.authUserId === input.playerId
    && input.geolocation !== null;
}

function updateFromCurrentPosition(
  input: EmergencyLocationHeartbeatInput & { playerId: string; geolocation: EmergencyHeartbeatGeolocation },
): Promise<boolean> {
  if (!input.isOnline() || !input.isCurrentPlayer()) return Promise.resolve(false);

  return new Promise(resolve => {
    let settled = false;
    const finish = (updated: boolean) => {
      if (settled) return;
      settled = true;
      resolve(updated);
    };

    try {
      input.geolocation.getCurrentPosition(position => {
        const { latitude, longitude, accuracy } = position.coords;
        if (!input.isCurrentPlayer()
          || !Number.isFinite(latitude)
          || !Number.isFinite(longitude)
          || !Number.isFinite(accuracy)
          || accuracy < 0
          || accuracy > MAX_LOCATION_ACCURACY_METERS) {
          finish(false);
          return;
        }

        void input.updatePrivateLocation({
          playerId: input.playerId,
          latitude,
          longitude,
        }).then(result => {
          if (result.ok === false) input.onFailure?.(result.reason);
          finish(result.ok);
        }).catch(error => {
          input.onFailure?.(error);
          finish(false);
        });
      }, error => {
        input.onFailure?.(error);
        finish(false);
      }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
    } catch (error) {
      input.onFailure?.(error);
      finish(false);
    }
  });
}

export function updateEmergencyLocationOnce(input: EmergencyLocationHeartbeatInput): Promise<boolean> {
  if (!isEligible(input)) return Promise.resolve(false);
  return updateFromCurrentPosition(input);
}

export function startEmergencyLocationHeartbeat(input: EmergencyLocationHeartbeatInput): () => void {
  if (!isEligible(input)) return () => {};

  const scheduler = input.scheduler ?? browserScheduler;
  let stopped = false;
  let updateInFlight = false;
  const activeInput = {
    ...input,
    isCurrentPlayer: () => !stopped && input.isCurrentPlayer(),
  };

  const refresh = () => {
    if (stopped || updateInFlight || !input.isOnline() || !input.isCurrentPlayer()) return;
    updateInFlight = true;
    void updateFromCurrentPosition(activeInput).finally(() => {
      updateInFlight = false;
    });
  };

  const timer = scheduler.setInterval(refresh, EMERGENCY_LOCATION_HEARTBEAT_INTERVAL_MS);
  refresh();

  return () => {
    if (stopped) return;
    stopped = true;
    scheduler.clearInterval(timer);
  };
}

export function createEmergencyLocationHeartbeatController() {
  let activeKey: string | null = null;
  let stopActive: () => void = () => {};

  return {
    sync(input: EmergencyLocationHeartbeatInput): void {
      const nextKey = isEligible(input) ? `${input.authUserId}\u0000${input.playerId}` : null;
      if (nextKey === activeKey) return;

      stopActive();
      stopActive = () => {};
      activeKey = nextKey;
      if (nextKey !== null) stopActive = startEmergencyLocationHeartbeat(input);
    },
    stop(): void {
      stopActive();
      stopActive = () => {};
      activeKey = null;
    },
  };
}
