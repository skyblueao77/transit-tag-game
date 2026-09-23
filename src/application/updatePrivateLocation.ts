import type {
  PrivateLocationStore,
  UpdatePrivateLocationInput,
  UpdatePrivateLocationResult,
} from './locationPorts.ts';

function isValidCoordinates(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

export async function updatePrivateLocation(
  input: UpdatePrivateLocationInput,
  store: PrivateLocationStore,
): Promise<UpdatePrivateLocationResult> {
  if (!input.playerId || !isValidCoordinates(input.latitude, input.longitude)) {
    return { ok: false, reason: 'INVALID_COORDINATES' };
  }

  try {
    await store.save(input.playerId, {
      latitude: input.latitude,
      longitude: input.longitude,
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
