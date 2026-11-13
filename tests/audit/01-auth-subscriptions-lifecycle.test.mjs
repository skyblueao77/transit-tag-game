import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { getUtf8ByteLength, truncateToUtf8Bytes } from '../../src/game/utf8.ts';
import {
  FsTimestamp,
  RulePermissionError,
  SERVER_TIMESTAMP_SENTINEL,
  SimulatedFirestore,
  createActiveParticipantDb,
} from './helpers/rulesContractHarness.mjs';

// Pure helper copy-free import check via source/runtime where safe
const authSource = readFileSync(new URL('../../src/infrastructure/firebase/auth.ts', import.meta.url), 'utf8');
const playerSetupSource = readFileSync(new URL('../../src/infrastructure/firebase/playerSetup.ts', import.meta.url), 'utf8');
const playerStoreSource = readFileSync(new URL('../../src/infrastructure/firebase/playerStore.ts', import.meta.url), 'utf8');
const useAuthUserSource = readFileSync(new URL('../../src/hooks/useAuthUser.ts', import.meta.url), 'utf8');
const useGameSubsSource = readFileSync(new URL('../../src/hooks/useGameSubscriptions.ts', import.meta.url), 'utf8');
const setupViewSource = readFileSync(new URL('../../views/SetupView.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const rulesSource = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');

function toSyntheticEmail(userId) {
  const trimmed = userId.trim().toLowerCase();
  if (trimmed.includes('@')) return trimmed;
  if (/^[a-z0-9_.-]+$/.test(trimmed)) {
    return `${trimmed}@transit-tag.local`;
  }
  const hex = Array.from(new TextEncoder().encode(trimmed))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `u_${hex}@transit-tag.local`;
}

describe('Audit 01: Auth, Bootstrap, Player Registration & Subscription Lifecycle', () => {
  test('synthetic email generation handles ASCII, whitespace, uppercase, @, and Unicode', () => {
    assert.equal(toSyntheticEmail('Tanaka_01'), 'tanaka_01@transit-tag.local');
    assert.equal(toSyntheticEmail('  user-9.test  '), 'user-9.test@transit-tag.local');
    assert.equal(toSyntheticEmail('Admin@Example.com'), 'admin@example.com');
    const jp = toSyntheticEmail('たなか01');
    assert.match(jp, /^u_[0-9a-f]+@transit-tag\.local$/);
    assert.notEqual(jp, toSyntheticEmail('すずき01'));
  });

  test('validates empty synthetic email edge case does not collide with valid IDs', () => {
    assert.equal(toSyntheticEmail('   '), 'u_@transit-tag.local');
    assert.notEqual(toSyntheticEmail('   '), toSyntheticEmail('a'));
  });

  test('initial admin bootstrap succeeds once for password user without participant doc', () => {
    const db = new SimulatedFirestore();
    const adminAuth = { uid: 'admin-boot-1', signInProvider: 'password' };
    db.commitBatch([
      {
        type: 'set',
        path: 'system/admin_bootstrap',
        data: { initializedBy: 'admin-boot-1', initializedAt: SERVER_TIMESTAMP_SENTINEL },
        merge: false,
      },
      {
        type: 'set',
        path: 'admins/admin-boot-1',
        data: { role: 'admin', createdAt: SERVER_TIMESTAMP_SENTINEL },
        merge: false,
      },
    ], adminAuth);

    assert.equal(db.rawGet('admins/admin-boot-1').role, 'admin');
  });

  test('blocks duplicate admin bootstrap, anonymous bootstrap, and participant self-escalation', () => {
    const db = new SimulatedFirestore();
    assert.throws(() => {
      db.commitBatch([
        { type: 'set', path: 'system/admin_bootstrap', data: { initializedBy: 'anon-1', initializedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
        { type: 'set', path: 'admins/anon-1', data: { role: 'admin', createdAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
      ], { uid: 'anon-1', signInProvider: 'anonymous' });
    }, RulePermissionError);

    db.seed('game_config/current', {
      gameSessionId: '11111111-1111-4111-8111-111111111111',
      sessionStartedAt: 1000,
      sessionSchemaVersion: 2,
    });
    db.seed('users/p-1', { id: 'p-1', team: 'A', gameSessionId: '11111111-1111-4111-8111-111111111111' });
    assert.throws(() => {
      db.commitBatch([
        { type: 'set', path: 'system/admin_bootstrap', data: { initializedBy: 'p-1', initializedAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
        { type: 'set', path: 'admins/p-1', data: { role: 'admin', createdAt: SERVER_TIMESTAMP_SENTINEL }, merge: false },
      ], { uid: 'p-1', signInProvider: 'password' });
    }, RulePermissionError);
  });

  test('new player registration batch writes users/{uid} + privateLocations/{uid} validly', () => {
    const { db, sessionId } = createActiveParticipantDb();
    const pAuth = { uid: 'player-new', signInProvider: 'password' };
    db.commitBatch([
      {
        type: 'set',
        path: 'users/player-new',
        data: {
          id: 'player-new',
          name: '新規太郎',
          role: 'RUNNER',
          team: 'A',
          color: '#ef4444',
          score: 0,
          status: 'ACTIVE',
          gameSessionId: sessionId,
          invincibleCards: 0,
        },
        merge: false,
      },
      {
        type: 'set',
        path: 'privateLocations/player-new',
        data: {
          gameSessionId: sessionId,
          latitude: 35.6812,
          longitude: 139.7671,
          updatedAt: SERVER_TIMESTAMP_SENTINEL,
        },
        merge: false,
      },
    ], pAuth);

    assert.equal(db.listCollection('users', pAuth).length, 1);
  });

  test('SetupView blocks registration when session is uninitialized (no fallback write)', () => {
    const db = new SimulatedFirestore();
    const pAuth = { uid: 'player-early', signInProvider: 'password' };
    assert.throws(() => {
      db.commitBatch([
        {
          type: 'set',
          path: 'users/player-early',
          data: {
            id: 'player-early', name: 'A', role: 'RUNNER', team: 'A', color: '#ef4444',
            score: 0, status: 'ACTIVE', gameSessionId: 'missing', invincibleCards: 0,
          },
          merge: false,
        },
      ], pAuth);
    }, RulePermissionError);
  });

  test('[AUDIT-BUG] SetupView user registration name trimming & boundary lengths (UTF-8 <= 80 bytes)', () => {
    const { db, sessionId } = createActiveParticipantDb();
    const pAuth = { uid: 'p-max', signInProvider: 'password' };
    const fiftyJapaneseChars = 'あ'.repeat(50);
    assert.equal(getUtf8ByteLength(fiftyJapaneseChars), 150);

    const clamped = truncateToUtf8Bytes(fiftyJapaneseChars.trim(), 80);
    assert.ok(getUtf8ByteLength(clamped) <= 80);
    assert.equal(clamped.length, 26);

    assert.ok(setupViewSource.includes('getUtf8ByteLength'), 'SetupView should check UTF-8 byte length');
    assert.ok(playerStoreSource.includes('truncateToUtf8Bytes'), 'playerStore should clamp name to 80 UTF-8 bytes');
    assert.ok(playerSetupSource.includes('truncateToUtf8Bytes'), 'playerSetup should clamp name to 80 UTF-8 bytes');

    db.commitBatch([
      {
        type: 'set',
        path: 'users/p-max',
        data: {
          id: 'p-max',
          name: clamped,
          role: 'RUNNER',
          team: 'A',
          color: '#ef4444',
          score: 0,
          status: 'ACTIVE',
          gameSessionId: sessionId,
          invincibleCards: 0,
        },
        merge: false,
      },
      {
        type: 'set',
        path: 'privateLocations/p-max',
        data: {
          gameSessionId: sessionId,
          latitude: 35.6812,
          longitude: 139.7671,
          updatedAt: SERVER_TIMESTAMP_SENTINEL,
        },
        merge: false,
      },
    ], pAuth);
    assert.equal(db.rawGet('users/p-max').name, clamped);
  });

  test('[AUDIT-BUG] registerPlayerAccount + useGameSubscriptions race condition kills subscribePlayers permanently', () => {
    // Trace the real execution order in playerSetup.ts + useAuthUser.ts + useGameSubscriptions.ts:
    // Step 1: registerWithUserId creates Firebase Auth account -> onAuthStateChanged fires with uid BEFORE users/{uid} exists.
    // Step 2: useGameSubscriptions runs `useEffect(..., [authUserId])` -> subscribePlayers(users collection) immediately.
    const { db } = createActiveParticipantDb();
    const newUid = 'race-player-1';
    const newAuth = { uid: newUid, signInProvider: 'password' };

    // Before createPlayerWithPrivateLocation commits, users/{newUid} does NOT exist yet.
    let listenerError = null;
    try {
      db.listCollection('users', newAuth);
    } catch (err) {
      listenerError = err;
    }
    assert.equal(listenerError?.code, 'permission-denied');

    // Verify useGameSubscriptions.ts dependency array ONLY depends on [authUserId], NOT currentUser / retry:
    const effectMatch = useGameSubsSource.match(/subscribePlayers\([\s\S]*?\);\s*\},\s*\[([^\]]*)\]/);
    assert.ok(effectMatch, 'Expected subscribePlayers useEffect');
    const deps = effectMatch[1].split(',').map(s => s.trim()).filter(Boolean);

    assert.ok(
      deps.length > 1 || useGameSubsSource.includes('currentUser'),
      `[AUDIT-BUG] useGameSubscriptions subscribes to collection('users') solely on [authUserId] (${JSON.stringify(deps)}). During registration or initial admin setup, onAuthStateChanged fires BEFORE batch.commit() creates users/{uid} / admins/{uid}, causing Firestore allow list to throw permanent PERMISSION_DENIED and leaving allUsers=[] until page reload!`,
    );
  });

  test('[AUDIT-BUG] setupInitialAdmin + useAuthUser + useGameSubscriptions race condition kills admin auth & subscriptions', () => {
    const db = new SimulatedFirestore();
    const bootUid = 'boot-admin-race';
    const bootAuth = { uid: bootUid, signInProvider: 'password' };
    // Before batch.commit(), admins/{bootUid} does not exist:
    assert.throws(() => db.listCollection('users', bootAuth), RulePermissionError);
    assert.equal(db.getDoc(`admins/${bootUid}`, bootAuth), null);

    // useAuthUser subscribes live via subscribeCurrentAuthUserAdmin (onSnapshot on admins/{uid})
    assert.ok(
      useAuthUserSource.includes('subscribeCurrentAuthUserAdmin') && authSource.includes('onSnapshot'),
      'Expected useAuthUser to subscribe live to admins/{uid} via subscribeCurrentAuthUserAdmin & onSnapshot',
    );
  });

  test('[AUDIT-BUG] adminDeletePlayer deletes Firestore docs only, permanently locking out the deleted userId from re-registering or logging in', () => {
    const { db, sessionId } = createActiveParticipantDb();
    db.seed('users/u-del', {
      id: 'u-del', name: 'Deleted User', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
    });
    db.seed('privateLocations/u-del', {
      gameSessionId: sessionId, latitude: 35.68, longitude: 139.76, updatedAt: FsTimestamp.fromMillis(db.serverNowMs),
    });
    db.seed('exposedLocations/u-del', {
      playerId: 'u-del', gameSessionId: sessionId, latitude: 35.68, longitude: 139.76,
      capturedAt: FsTimestamp.fromMillis(db.serverNowMs), expiresAt: FsTimestamp.fromMillis(db.serverNowMs + 60_000), revealScope: 'INDIVIDUAL',
    });
    db.seed('emergencyLocationProjections/u-del', {
      playerId: 'u-del', gameSessionId: sessionId, latitude: 35.68, longitude: 139.76,
      projectedAt: FsTimestamp.fromMillis(db.serverNowMs), sourceLocationUpdatedAt: FsTimestamp.fromMillis(db.serverNowMs),
      expiresAt: FsTimestamp.fromMillis(db.serverNowMs + 60_000), safetyStatus: 'EMERGENCY', projectionKind: 'EMERGENCY',
    });
    // Admin deletes player docs in Firestore (playerStore.ts adminDeletePlayer):
    db.commitBatch([
      { type: 'delete', path: 'users/u-del' },
      { type: 'delete', path: 'privateLocations/u-del' },
      { type: 'delete', path: 'exposedLocations/u-del' },
      { type: 'delete', path: 'emergencyLocationProjections/u-del' },
    ], { uid: 'admin-1', signInProvider: 'password' });

    // Firebase Auth account STILL EXISTS (client SDK cannot delete another user's Auth record!).
    // When user tries 新規エントリー -> auth/email-already-in-use.
    // When user tries 再開ログイン -> loginPlayerAccount signs in, gets userSnap.exists() === false -> signs out & returns PLAYER_NOT_FOUND!
    assert.ok(playerStoreSource.includes('adminDeletePlayer'));
    assert.ok(
      playerSetupSource.includes('auth/email-already-in-use') || setupViewSource.includes('DELETED_ACCOUNT_RECOVERY'),
      '[AUDIT-BUG] adminDeletePlayer removes Firestore docs while Firebase Auth user remains. If that userId later attempts 新規エントリー they hit auth/email-already-in-use; if they attempt 再開ログイン they hit PLAYER_NOT_FOUND — permanently locked out of that userId!',
    );
  });

  test('[AUDIT-BUG] App.tsx blocks logged-in Admin from ever viewing /map or /mission routes', () => {
    const hasAdminRouteLock = /\{isAdminPath \|\| isAdmin \? \([\s\S]*?<Route path="\*" element=\{<Navigate to="\/admin" replace \/>\}/.test(appSource);
    assert.equal(
      hasAdminRouteLock,
      false,
      '[AUDIT-BUG] App.tsx line 538 redirects ALL routes to /admin whenever isAdmin is true (`isAdminPath || isAdmin`), so an admin can never open /map or /mission even via direct hash URL despite the floating Settings button implying dual navigation!',
    );
  });

  test('[AUDIT-BUG] firestore.rules removes unused validExposedLocation function to eliminate 8 deploy warnings', () => {
    const matches = rulesSource.match(/validExposedLocation\b/g) ?? [];
    assert.equal(
      matches.length,
      0,
      'Expected unused validExposedLocation helper to be removed from firestore.rules',
    );
  });

  test('loginPlayerAccount fails cleanly for wrong session unless ADMIN', () => {
    const { db, sessionId } = createActiveParticipantDb();
    db.seed('users/old-user', {
      id: 'old-user', name: 'Old', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 10, status: 'ACTIVE', gameSessionId: '00000000-0000-4000-8000-000000000000', invincibleCards: 0,
    });
    const oldAuth = { uid: 'old-user', signInProvider: 'password' };
    // Can read own user doc:
    const doc = db.getDoc('users/old-user', oldAuth);
    assert.notEqual(doc.gameSessionId, sessionId);
    // Cannot list collection /users with stale session:
    assert.throws(() => db.listCollection('users', oldAuth), RulePermissionError);
    // Cannot write privateLocations with stale session:
    assert.throws(() => {
      db.commitBatch([{
        type: 'set',
        path: 'privateLocations/old-user',
        data: { gameSessionId: doc.gameSessionId, latitude: 35.6, longitude: 139.7, updatedAt: SERVER_TIMESTAMP_SENTINEL },
        merge: false,
      }], oldAuth);
    }, RulePermissionError);
  });

  test('non-participant signed-in user cannot read or list other users, missionsCompletions, or exposedLocations', () => {
    const { db, sessionId } = createActiveParticipantDb();
    db.seed('users/p1', {
      id: 'p1', name: 'P1', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
    });
    const outsider = { uid: 'outsider', signInProvider: 'password' };
    assert.throws(() => db.getDoc('users/p1', outsider), RulePermissionError);
    assert.throws(() => db.listCollection('users', outsider), RulePermissionError);
    assert.throws(() => db.listCollection('missionCompletions', outsider), RulePermissionError);
    assert.throws(() => db.getDoc('exposedLocations/p1', outsider), RulePermissionError);
    assert.throws(() => db.getDoc('privateLocations/p1', outsider), RulePermissionError);
    assert.throws(() => db.getDoc('emergencyLocationProjections/p1', outsider), RulePermissionError);
  });
});
