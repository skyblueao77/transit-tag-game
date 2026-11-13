import { doc, getDoc, increment, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebaseClient';
import type { User } from '../../../types';
import type { ProtectionZoneType } from '../../game/types';
import { TEAM_COLORS } from '../../../constants';

interface Coordinates {
  latitude: number;
  longitude: number;
}

function assertSignedInPlayer(playerId: string): string {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('UNAUTHENTICATED');
  if (typeof playerId !== 'string' || playerId.trim().length === 0 || uid !== playerId) {
    throw new Error('PERMISSION_DENIED');
  }
  return uid;
}

async function assertAdmin(): Promise<string> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('UNAUTHENTICATED');
  const adminSnap = await getDoc(doc(db, 'admins', uid));
  if (!adminSnap.exists()) throw new Error('PERMISSION_DENIED');
  return uid;
}

export async function createPlayerWithPrivateLocation(
  player: User,
  location: Coordinates,
  expectedSessionId: string,
): Promise<void> {
  assertSignedInPlayer(player.id);
  if (
    !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90
    || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180
    || typeof expectedSessionId !== 'string' || expectedSessionId.trim().length === 0
  ) {
    throw new Error('INVALID_ARGUMENT');
  }
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
  assertSignedInPlayer(playerId);
  const normalizedStation = typeof lastStation === 'string' ? lastStation.trim() : '';
  if (normalizedStation.length > 100) {
    throw new Error('INVALID_STATION');
  }
  const userRef = doc(db, 'users', playerId);
  await setDoc(userRef, { lastStation: normalizedStation }, { merge: true });
}

export async function adminChangePlayerTeam(
  playerId: string,
  newTeam: 'A' | 'B',
): Promise<void> {
  await assertAdmin();
  if (typeof playerId !== 'string' || playerId.trim().length === 0 || (newTeam !== 'A' && newTeam !== 'B')) {
    throw new Error('INVALID_ARGUMENT');
  }
  const userRef = doc(db, 'users', playerId);
  const color = newTeam === 'A' ? TEAM_COLORS[0] : TEAM_COLORS[1];
  await updateDoc(userRef, {
    team: newTeam,
    color,
  });
}

export async function adminDeletePlayer(playerId: string): Promise<void> {
  await assertAdmin();
  if (typeof playerId !== 'string' || playerId.trim().length === 0) {
    throw new Error('INVALID_ARGUMENT');
  }
  const batch = writeBatch(db);
  batch.delete(doc(db, 'users', playerId));
  batch.delete(doc(db, 'privateLocations', playerId));
  batch.delete(doc(db, 'exposedLocations', playerId));
  batch.delete(doc(db, 'emergencyLocationProjections', playerId));
  await batch.commit();
}

export async function updatePlayerProtectionZone(
  playerId: string,
  zone: ProtectionZoneType,
): Promise<void> {
  assertSignedInPlayer(playerId);
  if (zone !== 'NONE' && zone !== 'GREEN_CAR' && zone !== 'SAFE_ZONE') {
    throw new Error('INVALID_PROTECTION_ZONE');
  }
  const userRef = doc(db, 'users', playerId);
  await updateDoc(userRef, { protectionZone: zone });
}

export async function startPlayerShinkansen(playerId: string): Promise<void> {
  assertSignedInPlayer(playerId);
  const userRef = doc(db, 'users', playerId);
  await updateDoc(userRef, {
    shinkansenStartTime: Date.now(),
    shinkansenSegmentCount: 0,
  });
}

export async function incrementPlayerShinkansenSegment(playerId: string): Promise<void> {
  assertSignedInPlayer(playerId);
  const userRef = doc(db, 'users', playerId);
  await updateDoc(userRef, {
    shinkansenSegmentCount: increment(1),
  });
}

export async function resetPlayerShinkansen(playerId: string): Promise<void> {
  assertSignedInPlayer(playerId);
  const userRef = doc(db, 'users', playerId);
  await updateDoc(userRef, {
    shinkansenStartTime: null,
    shinkansenSegmentCount: 0,
  });
}

