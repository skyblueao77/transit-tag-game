import { doc, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebaseClient';
import type { User } from '../../../types';

interface Coordinates {
  latitude: number;
  longitude: number;
}

export async function createPlayerWithPrivateLocation(
  player: User,
  location: Coordinates,
): Promise<void> {
  const batch = writeBatch(db);
  batch.set(doc(db, 'users', player.id), player);
  batch.set(doc(db, 'privateLocations', player.id), {
    latitude: location.latitude,
    longitude: location.longitude,
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
}

export async function updatePlayerStatus(
  playerId: string,
  status: User['status'],
): Promise<void> {
  await updateDoc(doc(db, 'users', playerId), { status });
}
