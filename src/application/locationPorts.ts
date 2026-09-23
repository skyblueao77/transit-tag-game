import type { GameStatus } from '../game/types';

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface ExposedLocationSnapshot extends Coordinates {
  capturedAt: number;
  expiresAt: number;
}

export interface PrivateLocationStore {
  save(playerId: string, location: Coordinates): Promise<void>;
}

export interface ExposedLocationStore {
  saveSnapshot(playerId: string, snapshot: ExposedLocationSnapshot): Promise<void>;
}

export interface UpdatePrivateLocationInput extends Coordinates {
  playerId: string;
}

export interface ExposeLocationInput {
  playerId: string;
  privateLocation: Coordinates | null | undefined;
  phase: GameStatus;
  now: number;
  duration: number;
}

export type LocationUseCaseFailureReason =
  | 'INVALID_COORDINATES'
  | 'REVEAL_NOT_ALLOWED'
  | 'PRIVATE_LOCATION_MISSING'
  | 'PERSISTENCE_ERROR';

export interface LocationUseCaseFailure {
  ok: false;
  reason: LocationUseCaseFailureReason;
}

export interface UpdatePrivateLocationSuccess {
  ok: true;
}

export interface ExposeLocationSuccess {
  ok: true;
  snapshot: ExposedLocationSnapshot;
}

export type UpdatePrivateLocationResult =
  | UpdatePrivateLocationSuccess
  | LocationUseCaseFailure;

export type ExposeLocationResult = ExposeLocationSuccess | LocationUseCaseFailure;
