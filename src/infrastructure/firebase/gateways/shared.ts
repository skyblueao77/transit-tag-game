import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebaseClient.ts';
import { truncateToUtf8Bytes } from '../../../game/utf8.ts';

export const MAX_LOGS = 200;

export interface LogEntryInput {
  id: string;
  now: number;
  message: string;
  type: string;
}

export function formatLogTime(now: number): string {
  return new Date(now).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function appendToConfigLogs(configLogs: unknown, entry: LogEntryInput): unknown[] {
  const timeStr = formatLogTime(entry.now);
  const log = {
    id: entry.id,
    timestamp: entry.now,
    message: truncateToUtf8Bytes(`${timeStr} ${entry.message}`, 300, '...'),
    type: entry.type,
  };
  const prevLogs = Array.isArray(configLogs) ? configLogs : [];
  return [log, ...prevLogs].slice(0, MAX_LOGS);
}

export function generateSecureId(prefix = ''): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      const uuid = crypto.randomUUID();
      return prefix ? `${prefix}_${uuid}` : uuid;
    }
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return prefix ? `${prefix}_${hex}` : hex;
    }
  }
  throw new Error('Secure random generator is not available in this runtime.');
}

export async function computeResetFingerprint(fingerprintInput: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    const encoded = new TextEncoder().encode(fingerprintInput);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback FNV-1a 64-bit hex if subtle crypto is unavailable in an insecure context
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < fingerprintInput.length; i += 1) {
    const code = fingerprintInput.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function createLogId(): string {
  return generateSecureId('log');
}

export function requireAuthUid(): string {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('UNAUTHENTICATED');
  return uid;
}

export function assertSignedInPlayer(playerId: string): string {
  const uid = requireAuthUid();
  if (typeof playerId !== 'string' || playerId.trim().length === 0 || uid !== playerId) {
    throw new Error('PERMISSION_DENIED');
  }
  return uid;
}

export async function verifyAdmin(uid: string): Promise<boolean> {
  const adminSnap = await getDoc(doc(db, 'admins', uid));
  return adminSnap.exists();
}

export async function assertAdmin(): Promise<string> {
  const uid = requireAuthUid();
  if (!(await verifyAdmin(uid))) {
    throw new Error('PERMISSION_DENIED');
  }
  return uid;
}

export function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
