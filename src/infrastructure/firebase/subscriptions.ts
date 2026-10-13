import {
  collection,
  doc,
  onSnapshot,

  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebaseClient';
import type { EmergencyLocationProjection, ExposedLocation, GameConfig, Mission, PrivateLocation, User } from '../../../types';
import {
  mapEmergencyLocationProjection,
  mapExposedLocationDocuments,
  mapGameConfigDocument,
  mapMissionDocuments,
  mapPlayerDocuments,
  mapPrivateLocation,
  mapUserDocument,
} from './snapshotMappers';

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

export function subscribePrivateLocation(
  uid: string,
  expectedSessionId: string,
  onValue: (location: PrivateLocation | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(doc(db, 'privateLocations', uid), snapshot => {
    const location = snapshot.exists() ? mapPrivateLocation(snapshot.data()) : null;
    onValue(location?.gameSessionId === expectedSessionId ? location : null);
  }, onError);
}

export function subscribeExposedLocations(
  playerIds: readonly string[],
  expectedSessionId: string,
  onValue: (locations: Record<string, ExposedLocation>) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  let active = true;
  const values: Record<string, ExposedLocation> = {};
  const publish = () => {
    if (active) onValue({ ...values });
  };
  const unsubscribes = [...new Set(playerIds)].map(playerId => onSnapshot(
    doc(db, 'exposedLocations', playerId),
    snapshot => {
      const mapped = mapExposedLocationDocuments(snapshot.exists()
        ? [{ id: snapshot.id, data: snapshot.data() }]
        : [], expectedSessionId);
      if (mapped[playerId]) values[playerId] = mapped[playerId];
      else delete values[playerId];
      publish();
    },
    error => {
      delete values[playerId];
      publish();
      if ((error as Error & { code?: string }).code !== 'permission-denied') onError(error);
    },
  ));
  publish();
  return () => {
    active = false;
    unsubscribes.forEach(unsubscribe => unsubscribe());
  };
}

export function subscribeEmergencyLocationProjections(
  playerIds: readonly string[],
  expectedSessionId: string,
  onValue: (projections: EmergencyLocationProjection[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  let active = true;
  const values = new Map<string, EmergencyLocationProjection>();
  const publish = () => {
    if (!active) return;
    const now = Date.now();
    onValue([...values.values()].filter(projection => projection.expiresAt > now));
  };
  const unsubscribes = [...new Set(playerIds)].map(playerId => onSnapshot(
    doc(db, 'emergencyLocationProjections', playerId),
    snapshot => {
      const projection = mapEmergencyLocationProjection(
        snapshot.id,
        snapshot.exists() ? snapshot.data() : null,
        expectedSessionId,
      );
      if (projection) values.set(playerId, projection);
      else values.delete(playerId);
      publish();
    },
    onError,
  ));
  publish();
  return () => {
    active = false;
    unsubscribes.forEach(unsubscribe => unsubscribe());
  };
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
