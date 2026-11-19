import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebaseClient';
import type { EmergencyLocationProjection, ExposedLocation, GameConfig, Mission, MissionCompletion, PrivateLocation, User } from '../../../types';
import {
  mapEmergencyLocationProjection,
  mapExposedLocationDocuments,
  mapGameConfigDocument,
  mapMissionDocuments,
  mapPlayerDocuments,
  mapPrivateLocation,
  mapUserDocument,
} from './snapshotMappers';
import {
  createDifferentialPlayerSubscriber,
  type DifferentialPlayerSubscriber,
} from '../differentialPlayerSubscriber';
import { recordConfirmedServerTimestamp } from './serverClock';

export function subscribeCurrentPlayer(
  uid: string,
  onValue: (player: User | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(doc(db, 'users', uid), snapshot => {
    onValue(snapshot.exists() ? mapUserDocument(snapshot.id, snapshot.data()) : null);
  }, onError);
}

export function subscribePlayers(
  onValue: (players: User[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(collection(db, 'users'), snapshot => {
    onValue(mapPlayerDocuments(snapshot.docs.map(document => ({
      id: document.id,
      data: document.data(),
    }))));
  }, onError);
}

export function subscribeMissions(
  onValue: (missions: Mission[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(collection(db, 'missions'), snapshot => {
    onValue(mapMissionDocuments(snapshot.docs.map(document => ({
      id: document.id,
      data: document.data(),
    }))));
  }, onError);
}

export async function fetchPrivateLocation(
  uid: string,
  expectedSessionId: string,
): Promise<PrivateLocation | null> {
  const snapshot = await getDoc(doc(db, 'privateLocations', uid));
  if (!snapshot.exists()) return null;
  const location = mapPrivateLocation(snapshot.data());
  return location?.gameSessionId === expectedSessionId ? location : null;
}

export function subscribePrivateLocation(
  uid: string,
  expectedSessionId: string,
  onValue: (location: PrivateLocation | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(doc(db, 'privateLocations', uid), snapshot => {
    const rawData = snapshot.exists() ? snapshot.data() : null;
    const updatedAt = rawData?.updatedAt;
    if (updatedAt && typeof updatedAt === 'object' && 'toMillis' in updatedAt && typeof updatedAt.toMillis === 'function') {
      recordConfirmedServerTimestamp(updatedAt.toMillis(), {
        hasPendingWrites: snapshot.metadata.hasPendingWrites,
        fromCache: snapshot.metadata.fromCache,
      });
    }
    const location = rawData ? mapPrivateLocation(rawData) : null;
    onValue(location?.gameSessionId === expectedSessionId ? location : null);
  }, onError);
}

export function subscribeExposedLocations(
  playerIds: readonly string[],
  expectedSessionId: string,
  onValue: (locations: Record<string, ExposedLocation>) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const subscriber = createExposedLocationsSubscriber(expectedSessionId, onValue, onError);
  subscriber.setPlayerIds(playerIds);
  return subscriber.dispose;
}

export type ExposedLocationsSubscriber = DifferentialPlayerSubscriber;

export function createExposedLocationsSubscriber(
  expectedSessionId: string,
  onValue: (locations: Record<string, ExposedLocation>) => void,
  onError: (error: Error) => void,
): ExposedLocationsSubscriber {
  return createDifferentialPlayerSubscriber<ExposedLocation>({
    subscribePlayer: (playerId, onNext, onFailure) => onSnapshot(
      doc(db, 'exposedLocations', playerId),
      snapshot => {
        const mapped = mapExposedLocationDocuments(
          snapshot.exists() ? [{ id: snapshot.id, data: snapshot.data() }] : [],
          expectedSessionId,
        );
        onNext(mapped[playerId] ?? null);
      },
      onFailure,
    ),
    onPublish: values => {
      onValue(Object.fromEntries(values.entries()));
    },
    onError,
  });
}

export type EmergencyLocationProjectionsSubscriber = DifferentialPlayerSubscriber;

export function createEmergencyLocationProjectionsSubscriber(
  expectedSessionId: string,
  onValue: (projections: EmergencyLocationProjection[]) => void,
  onError: (error: Error) => void,
): EmergencyLocationProjectionsSubscriber {
  return createDifferentialPlayerSubscriber<EmergencyLocationProjection>({
    subscribePlayer: (playerId, onNext, onFailure) => onSnapshot(
      doc(db, 'emergencyLocationProjections', playerId),
      snapshot => {
        const projection = mapEmergencyLocationProjection(
          snapshot.id,
          snapshot.exists() ? snapshot.data() : null,
          expectedSessionId,
        );
        onNext(projection);
      },
      onFailure,
    ),
    onPublish: values => {
      onValue([...values.values()]);
    },
    onError,
  });
}

export function subscribeEmergencyLocationProjections(
  playerIds: readonly string[],
  expectedSessionId: string,
  onValue: (projections: EmergencyLocationProjection[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const subscriber = createEmergencyLocationProjectionsSubscriber(expectedSessionId, onValue, onError);
  subscriber.setPlayerIds(playerIds);
  return subscriber.dispose;
}

export function subscribeGameConfig(
  defaults: GameConfig,
  onValue: (config: GameConfig) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const configRef = doc(db, 'game_config', 'current');
  return onSnapshot(configRef, snapshot => {
    if (snapshot.exists()) {
      onValue(mapGameConfigDocument(snapshot.data(), defaults));
      return;
    }

    // A missing Config must not be created with client-authoritative defaults.
    onValue(defaults);
  }, onError);
}

export function subscribeMissionCompletions(
  expectedSessionId: string,
  onValue: (completions: Array<MissionCompletion & { id: string }>) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db, 'missionCompletions'),
    where('gameSessionId', '==', expectedSessionId),
  );
  return onSnapshot(q, snapshot => {
    const completions = snapshot.docs.map(document => ({
      id: document.id,
      ...(document.data() as MissionCompletion),
    }));
    onValue(completions);
  }, onError);
}

