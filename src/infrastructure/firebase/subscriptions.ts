import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebaseClient';
import type { ExposedLocation, GameConfig, Mission, PrivateLocation, User } from '../../../types';
import {
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
  onValue: (location: PrivateLocation | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(doc(db, 'privateLocations', uid), snapshot => {
    onValue(snapshot.exists() ? mapPrivateLocation(snapshot.data()) : null);
  }, onError);
}

export function subscribeExposedLocations(
  onValue: (locations: Record<string, ExposedLocation>) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(collection(db, 'exposedLocations'), snapshot => {
    onValue(mapExposedLocationDocuments(snapshot.docs.map(document => ({
      id: document.id,
      data: document.data(),
    }))));
  }, onError);
}

export function subscribeGameConfig(
  defaults: GameConfig,
  onValue: (config: GameConfig) => void,
  onError: (error: Error) => void,
  onSeedError: (error: Error) => void = onError,
): Unsubscribe {
  const configRef = doc(db, 'game_config', 'current');
  return onSnapshot(configRef, snapshot => {
    if (snapshot.exists()) {
      onValue(mapGameConfigDocument(snapshot.data(), defaults));
      return;
    }

    void setDoc(configRef, defaults).catch(onSeedError);
  }, onError);
}
