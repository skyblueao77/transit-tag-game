import type { ExposedLocation, GameConfig, Mission, PrivateLocation, User } from '../../../types';
import type { GameLog } from '../../../types';

export function mapUserDocument(id: string, data: Record<string, unknown>): User {
  return { id, ...data } as User;
}

export function mapPlayerDocuments(
  documents: readonly { id: string; data: Record<string, unknown> }[],
): User[] {
  return documents.map(document => mapUserDocument(document.id, document.data));
}

export function mapMissionDocuments(
  documents: readonly { id: string; data: Record<string, unknown> }[],
): Mission[] {
  return documents.map(document => ({ id: document.id, ...document.data }) as Mission);
}

export function mapPrivateLocation(data: Record<string, unknown> | null): PrivateLocation | null {
  return data ? data as unknown as PrivateLocation : null;
}

export function mapExposedLocationDocuments(
  documents: readonly { id: string; data: Record<string, unknown> }[],
): Record<string, ExposedLocation> {
  return Object.fromEntries(
    documents.map(document => [document.id, document.data as unknown as ExposedLocation]),
  );
}

export function mapGameConfigDocument(
  data: Record<string, unknown>,
  defaults: GameConfig,
): GameConfig {
  return {
    ...defaults,
    ...data,
    logs: (data.logs as GameLog[] | undefined) ?? [],
  } as GameConfig;
}
