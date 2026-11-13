import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { computeMapTimeLeft } from '../../src/game/mapTimers.ts';
import { activateInvincibility } from '../../src/game/powerups.ts';
import {
  resumeExpiredWaiting,
  startManualWaiting,
  startShinkansenLimitWaiting,
} from '../../src/game/waitingLifecycle.ts';
import {
  getServerNowMs,
  resetServerClockForTest,
  setServerTimeOffsetMsForTest,
} from '../../src/infrastructure/firebase/serverClock.ts';
import {
  RulePermissionError,
  createActiveParticipantDb,
  incrementSentinel,
} from './helpers/rulesContractHarness.mjs';

const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const runnerControlsSource = readFileSync(new URL('../../views/map/MapRunnerControls.tsx', import.meta.url), 'utf8');
const waitingAutoResumeSource = readFileSync(new URL('../../src/hooks/useWaitingAutoResume.ts', import.meta.url), 'utf8');

describe('Audit 05: Shinkansen Tracker, Waiting Auto-Resume, Invincibility & Map Timers', () => {
  test('Shinkansen start -> segment increment -> 2nd ride after non-zero previous segment count passes rules', () => {
    const { db, sessionId } = createActiveParticipantDb();
    db.seed('users/r1', {
      id: 'r1', name: 'Runner 1', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 1,
    });
    const rAuth = { uid: 'r1', signInProvider: 'password' };

    db.commitBatch([{
      type: 'update',
      path: 'users/r1',
      data: { shinkansenStartTime: db.serverNowMs, shinkansenSegmentCount: 0 },
    }], rAuth);

    db.commitBatch([{ type: 'update', path: 'users/r1', data: { shinkansenSegmentCount: incrementSentinel(1) } }], rAuth);
    db.commitBatch([{ type: 'update', path: 'users/r1', data: { shinkansenSegmentCount: incrementSentinel(1) } }], rAuth);
    assert.equal(db.rawGet('users/r1').shinkansenSegmentCount, 2);

    db.commitBatch([
      { type: 'update', path: 'users/r1', data: { status: 'WAITING', waitingUntil: db.serverNowMs + 3_600_000, shinkansenStartTime: null } },
      { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'w1', timestamp: db.serverNowMs, message: 'wait', type: 'SYSTEM' }] } },
    ], rAuth);

    db.advanceServerTime(3_600_000);
    db.commitBatch([
      { type: 'update', path: 'users/r1', data: { status: 'ACTIVE', waitingUntil: 0, shinkansenStartTime: null } },
      { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'w2', timestamp: db.serverNowMs, message: 'resume', type: 'SYSTEM' }, ...db.rawGet('game_config/current').logs] } },
    ], rAuth);

    db.commitBatch([{
      type: 'update',
      path: 'users/r1',
      data: { shinkansenStartTime: db.serverNowMs, shinkansenSegmentCount: 0 },
    }], rAuth);
    assert.equal(db.rawGet('users/r1').shinkansenSegmentCount, 0);
  });

  test('Shinkansen 60s cancel fails after 60s or after +1 segment increment', () => {
    const { db, sessionId } = createActiveParticipantDb();
    const startMs = db.serverNowMs;
    db.seed('users/r1', {
      id: 'r1', name: 'Runner 1', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
      shinkansenStartTime: startMs, shinkansenSegmentCount: 0,
    });
    const rAuth = { uid: 'r1', signInProvider: 'password' };

    db.advanceServerTime(30_000);
    db.commitBatch([{
      type: 'update',
      path: 'users/r1',
      data: { shinkansenStartTime: null, shinkansenSegmentCount: 0 },
    }], rAuth);

    db.commitBatch([{
      type: 'update',
      path: 'users/r1',
      data: { shinkansenStartTime: db.serverNowMs, shinkansenSegmentCount: 0 },
    }], rAuth);
    db.advanceServerTime(61_000);
    assert.throws(() => {
      db.commitBatch([{
        type: 'update',
        path: 'users/r1',
        data: { shinkansenStartTime: null, shinkansenSegmentCount: 0 },
      }], rAuth);
    }, RulePermissionError);
  });

  test('[AUDIT-BUG] App.tsx handleResetShinkansen swallows errors silently without user toast notification', () => {
    const match = appSource.match(/const handleResetShinkansen = useCallback\([\s\S]*?\}, \[currentUser\]\);/);
    assert.ok(match, 'handleResetShinkansen must exist in App.tsx');
    assert.match(
      match[0],
      /toast\.error/,
      '[AUDIT-BUG] App.tsx handleResetShinkansen catches Firestore errors with console.error only and never calls toast.error(), leaving user confused when 60s window expires or network fails!',
    );
  });

  test('[AUDIT-BUG] useWaitingAutoResume fires at client Date.now() >= waitingUntil without server clock offset, failing PERMISSION_DENIED on retry loop if client clock > server clock', () => {
    const { db, sessionId } = createActiveParticipantDb();
    const waitingUntil = db.serverNowMs + 60_000;
    db.seed('users/r1', {
      id: 'r1', name: 'Runner 1', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'WAITING', waitingUntil, gameSessionId: sessionId, invincibleCards: 0,
    });

    db.setServerTime(waitingUntil - 2_000);
    const clientNow = waitingUntil;
    const domainCheck = resumeExpiredWaiting({ status: 'WAITING', waitingUntil, now: clientNow });
    assert.equal(domainCheck.allowed, true);
    assert.equal(domainCheck.changed, true);

    assert.throws(() => {
      db.commitBatch([
        { type: 'update', path: 'users/r1', data: { status: 'ACTIVE', waitingUntil: 0, shinkansenStartTime: null } },
        { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'res1', timestamp: clientNow, message: 'Resumed', type: 'SYSTEM' }] } },
      ], { uid: 'r1', signInProvider: 'password' });
    }, RulePermissionError);

    assert.ok(
      waitingAutoResumeSource.includes('serverTimeOffset'),
      '[AUDIT-BUG] useWaitingAutoResume uses raw client Date.now() instead of server-synced clock offset, so any client clock even 1s ahead triggers PERMISSION_DENIED every 5s when waiting expires!',
    );
  });

  test('[AUDIT-BUG] serverClock corrects > +60s client clock skew so startManualWaiting & activateInvincibility pass firestore.rules', () => {
    const { db, sessionId } = createActiveParticipantDb();
    db.seed('users/r1', {
      id: 'r1', name: 'Runner 1', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 2,
    });
    db.seed('users/r2', {
      id: 'r2', name: 'Runner 2', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 2,
    });
    const rAuth = { uid: 'r1', signInProvider: 'password' };
    const r2Auth = { uid: 'r2', signInProvider: 'password' };
    const skewedClientNow = db.serverNowMs + 65_000;

    try {
      setServerTimeOffsetMsForTest(db.serverNowMs - skewedClientNow);
      const syncedNow = getServerNowMs(skewedClientNow);
      assert.equal(syncedNow, db.serverNowMs);

      const waitRes = startManualWaiting({
        status: 'ACTIVE', role: 'RUNNER', phase: 'DAY1_ACTIVE', now: syncedNow, shinkansenWaitDurationMs: 60 * 60_000,
      });
      assert.equal(waitRes.allowed, true);
      db.commitBatch([
        { type: 'update', path: 'users/r1', data: { status: 'WAITING', waitingUntil: waitRes.waitingUntil, shinkansenStartTime: null } },
        { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'l', timestamp: syncedNow, message: 'w', type: 'SYSTEM' }] } },
      ], rAuth);
      assert.equal(db.rawGet('users/r1').status, 'WAITING');

      const invRes = activateInvincibility({
        role: 'RUNNER', invincibleCards: 2, invincibleUntil: 0, phase: 'DAY1_ACTIVE', now: syncedNow,
      });
      assert.equal(invRes.allowed, true);
      db.commitBatch([
        { type: 'update', path: 'users/r2', data: { invincibleCards: 1, invincibleUntil: invRes.invincibleUntil } },
        { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'l2', timestamp: syncedNow, message: 'inv', type: 'SYSTEM' }, ...db.rawGet('game_config/current').logs] } },
      ], r2Auth);
      assert.equal(db.rawGet('users/r2').invincibleCards, 1);
    } finally {
      resetServerClockForTest();
    }
  });

  for (const postMinutes of [1, 5, 60, 120, 180]) {
    test(`startManualWaiting works with custom postShinkansenWaitMinutes=${postMinutes} when clocks aligned`, () => {
      const { db, sessionId } = createActiveParticipantDb({
        config: { postShinkansenWaitMinutes: postMinutes },
      });
      db.seed('users/r1', {
        id: 'r1', name: 'Runner 1', role: 'RUNNER', team: 'A', color: '#ef4444',
        score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 0,
      });
      const res = startManualWaiting({
        status: 'ACTIVE',
        role: 'RUNNER',
        phase: 'DAY1_ACTIVE',
        now: db.serverNowMs,
        shinkansenWaitDurationMs: postMinutes * 60_000,
      });
      assert.equal(res.allowed, true);
      db.commitBatch([
        { type: 'update', path: 'users/r1', data: { status: 'WAITING', waitingUntil: res.waitingUntil, shinkansenStartTime: null } },
        { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'lw', timestamp: db.serverNowMs, message: 'wait', type: 'SYSTEM' }] } },
      ], { uid: 'r1', signInProvider: 'password' });
      assert.equal(db.rawGet('users/r1').status, 'WAITING');
    });
  }

  test('startShinkansenLimitWaiting enforces duration (unlimited vs bounded) and segment caps strictly', () => {
    const now = 1_750_000_000_000;
    // Exact boundary (now - start === limitMs) is NOT yet exceeded:
    assert.equal(startShinkansenLimitWaiting({
      status: 'ACTIVE',
      phase: 'DAY1_ACTIVE',
      shinkansenStartTime: now - 150 * 60_000,
      shinkansenSegmentCount: 0,
      now,
      shinkansenLimitDurationMs: 150 * 60_000,
    }).reason, 'SHINKANSEN_LIMIT_NOT_REACHED');

    // +1ms past limit IS exceeded:
    const exceededTime = startShinkansenLimitWaiting({
      status: 'ACTIVE',
      phase: 'DAY1_ACTIVE',
      shinkansenStartTime: now - 150 * 60_000 - 1,
      shinkansenSegmentCount: 0,
      now,
      shinkansenLimitDurationMs: 150 * 60_000,
    });
    assert.equal(exceededTime.allowed, true);
    assert.equal(exceededTime.action, 'SHINKANSEN_LIMIT');

    // Bounded segments reached with shinkansenMaxSegments:
    const exceededSeg = startShinkansenLimitWaiting({
      status: 'ACTIVE',
      phase: 'DAY1_ACTIVE',
      shinkansenStartTime: now - 1_000,
      shinkansenSegmentCount: 3,
      now,
      shinkansenMaxSegments: 3,
    });
    assert.equal(exceededSeg.allowed, true);
  });

  test('computeMapTimeLeft returns Infinity for unlimited shinkansen and pauses config timers cleanly', () => {
    const now = 1_750_000_000_000;
    const unlimited = computeMapTimeLeft({
      currentUser: { team: 'A', status: 'ACTIVE', shinkansenStartTime: now - 60_000 },
      gameConfig: { gameStatus: 'DAY1_ACTIVE', shinkansenMaxMinutes: 0, nextRevealTime: now + 600_000 },
      currentRole: 'RUNNER',
      now,
    });
    assert.equal(unlimited.shinkansenRemaining, Number.POSITIVE_INFINITY);

    assert.match(runnerControlsSource, /maxMinutes > 0 \? formatTime\(timeLeft\.shinkansenRemaining\) : '無制限'/);

    const paused = computeMapTimeLeft({
      currentUser: { team: 'A', status: 'WAITING', waitingUntil: now + 120_000 },
      gameConfig: { gameStatus: 'DAY1_PAUSED', startTime: now - 100_000, nextRevealTime: now + 10_000 },
      currentRole: 'ONI',
      now,
    }, unlimited);
    assert.equal(paused.waiting, 120);
    assert.equal(paused.nextReveal, 600);
  });

  test('invincibility activation & expiration lifecycle passes firestore.rules', () => {
    const { db, sessionId } = createActiveParticipantDb();
    db.seed('users/r1', {
      id: 'r1', name: 'Runner 1', role: 'RUNNER', team: 'A', color: '#ef4444',
      score: 0, status: 'ACTIVE', gameSessionId: sessionId, invincibleCards: 2,
    });
    const rAuth = { uid: 'r1', signInProvider: 'password' };

    const act1 = activateInvincibility({ role: 'RUNNER', invincibleCards: 2, invincibleUntil: 0, phase: 'DAY1_ACTIVE', now: db.serverNowMs });
    assert.equal(act1.allowed, true);
    db.commitBatch([
      { type: 'update', path: 'users/r1', data: { invincibleCards: 1, invincibleUntil: act1.invincibleUntil } },
      { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'i1', timestamp: db.serverNowMs, message: 'Inv 1', type: 'SYSTEM' }] } },
    ], rAuth);

    assert.throws(() => {
      db.commitBatch([
        { type: 'update', path: 'users/r1', data: { invincibleCards: 0, invincibleUntil: db.serverNowMs + 1_800_000 } },
        { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'i2', timestamp: db.serverNowMs, message: 'Inv 2', type: 'SYSTEM' }, ...db.rawGet('game_config/current').logs] } },
      ], rAuth);
    }, RulePermissionError);

    db.advanceServerTime(1_800_000);
    db.commitBatch([
      { type: 'update', path: 'users/r1', data: { invincibleCards: 0, invincibleUntil: db.serverNowMs + 1_800_000 } },
      { type: 'update', path: 'game_config/current', data: { logs: [{ id: 'i3', timestamp: db.serverNowMs, message: 'Inv 3', type: 'SYSTEM' }, ...db.rawGet('game_config/current').logs] } },
    ], rAuth);
    assert.equal(db.rawGet('users/r1').invincibleCards, 0);
  });
});
