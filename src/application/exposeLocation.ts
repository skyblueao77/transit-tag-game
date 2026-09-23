import { canRevealLocation } from '../game/phases.ts';
import type {
  ExposeLocationInput,
  ExposeLocationResult,
  ExposedLocationStore,
} from './locationPorts.ts';

function isValidCoordinates(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

export async function exposeLocation(
  input: ExposeLocationInput,
  store: ExposedLocationStore,
): Promise<ExposeLocationResult> {
  const privateLocation = input.privateLocation;
  if (!canRevealLocation(input.phase)) {
    return { ok: false, reason: 'REVEAL_NOT_ALLOWED' };
  }
  if (!privateLocation) {
    return { ok: false, reason: 'PRIVATE_LOCATION_MISSING' };
  }
  if (!Number.isFinite(input.now) || !Number.isFinite(input.duration) || input.duration < 0) {
    return { ok: false, reason: 'INVALID_COORDINATES' };
  }
  if (!isValidCoordinates(privateLocation.latitude, privateLocation.longitude)) {
    return { ok: false, reason: 'INVALID_COORDINATES' };
  }

  const snapshot = {
    latitude: privateLocation.latitude,
    longitude: privateLocation.longitude,
    capturedAt: input.now,
    expiresAt: input.now + input.duration,
  };

  try {
    await store.saveSnapshot(input.playerId, snapshot);
    return { ok: true, snapshot };
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
