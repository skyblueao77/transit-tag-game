import { doc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebaseClient';
import type { User } from '../../../types';

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
