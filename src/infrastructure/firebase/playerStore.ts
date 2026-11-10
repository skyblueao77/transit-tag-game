import { doc, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebaseClient';
import type { User } from '../../../types';
import { TEAM_COLORS } from '../../../constants';

interface Coordinates {
  latitude: number;
  longitude: number;
}

export async function createPlayerWithPrivateLocation(
  player: User,
  location: Coordinates,
  expectedSessionId: string,
): Promise<void> {
  const batch = writeBatch(db);
  batch.set(doc(db, 'users', player.id), { ...player, gameSessionId: expectedSessionId });
  batch.set(doc(db, 'privateLocations', player.id), {
    gameSessionId: expectedSessionId,
    latitude: location.latitude,
    longitude: location.longitude,
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
}

export async function updatePlayerLastStation(
  playerId: string,
  lastStation: string,
): Promise<void> {
  const userRef = doc(db, 'users', playerId);
  await setDoc(userRef, { lastStation }, { merge: true });
}

export async function adminChangePlayerTeam(
  playerId: string,
  newTeam: 'A' | 'B',
): Promise<void> {
  const userRef = doc(db, 'users', playerId);
  const color = newTeam === 'A' ? TEAM_COLORS[0] : TEAM_COLORS[1];
  await updateDoc(userRef, {
    team: newTeam,
    color,
  });
}

export async function adminDeletePlayer(playerId: string): Promise<void> {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'users', playerId));
  batch.delete(doc(db, 'privateLocations', playerId));
  batch.delete(doc(db, 'exposedLocations', playerId));
  batch.delete(doc(db, 'emergencyLocationProjections', playerId));
  await batch.commit();
}
