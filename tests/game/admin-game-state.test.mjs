import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  resolveAdminPlayerResume,
  resolveAdminRoleSwap,
} from '../../src/game/adminGameState.ts';
import { ONI_INITIAL_LOCK_DURATION_MS } from '../../src/game/time.ts';

const now = 1_800_000_000_000;
const roles = { teamARole: 'ONI', teamBRole: 'RUNNER' };

function player(id, team, status, extra = {}) {
  return { id, team, status, ...extra };
}

describe('Admin Game State Core', () => {
  test('swaps roles and synchronizes only ordinary A/B roster players', () => {
    const players = [
      player('a-active', 'A', 'ACTIVE'),
      player('a-waiting', 'A', 'WAITING'),
      player('b-active', 'B', 'ACTIVE'),
      player('b-waiting', 'B', 'WAITING'),
      player('a-emergency', 'A', 'EMERGENCY'),
      player('b-retired', 'B', 'RETIRED'),
      player('a-captured', 'A', 'CAPTURED'),
      player('admin', 'ADMIN', 'ACTIVE'),
      player('unknown-team', 'X', 'ACTIVE'),
    ];
    const input = { teamRoles: roles, players, now };
    const before = structuredClone(input);
    const result = resolveAdminRoleSwap(input);

    assert.deepEqual(result, {
      allowed: true,
      teamRoles: { teamARole: 'RUNNER', teamBRole: 'ONI' },
      nextRevealTime: now + ONI_INITIAL_LOCK_DURATION_MS,
      newOniTeam: 'B',
      playerChanges: [
        { playerId: 'a-active', status: 'ACTIVE', waitingUntil: 0, shinkansenStartTime: null },
        { playerId: 'a-waiting', status: 'ACTIVE', waitingUntil: 0, shinkansenStartTime: null },
        { playerId: 'b-active', status: 'WAITING', waitingUntil: now + ONI_INITIAL_LOCK_DURATION_MS, shinkansenStartTime: null, invincibleUntil: 0 },
        { playerId: 'b-waiting', status: 'WAITING', waitingUntil: now + ONI_INITIAL_LOCK_DURATION_MS, shinkansenStartTime: null, invincibleUntil: 0 },
      ],
      excludedSafetyPlayerIds: ['a-emergency', 'b-retired'],
    });
    assert.deepEqual(input, before);
  });

  test('rejects invalid, non-complementary roles, malformed players, duplicate IDs, and invalid time', () => {
    assert.deepEqual(resolveAdminRoleSwap({ teamRoles: { teamARole: 'ONI', teamBRole: 'ONI' }, players: [], now }), {
      allowed: false, reason: 'INVALID_ROLES',
    });
    assert.deepEqual(resolveAdminRoleSwap({ teamRoles: null, players: [], now }), {
      allowed: false, reason: 'INVALID_ROLES',
    });
    assert.deepEqual(resolveAdminRoleSwap({ teamRoles: roles, players: null, now }), {
      allowed: false, reason: 'INVALID_PLAYER',
    });
    assert.deepEqual(resolveAdminRoleSwap({ teamRoles: roles, players: [], now: Number.NaN }), {
      allowed: false, reason: 'INVALID_TIME',
    });
    assert.deepEqual(resolveAdminRoleSwap({ teamRoles: roles, players: [player('', 'A', 'ACTIVE')], now }), {
      allowed: false, reason: 'INVALID_PLAYER',
    });
    assert.deepEqual(resolveAdminRoleSwap({ teamRoles: roles, players: [player('a', 'A', 'UNKNOWN')], now }), {
      allowed: false, reason: 'INVALID_PLAYER',
    });
    assert.deepEqual(resolveAdminRoleSwap({ teamRoles: roles, players: [player('a', 'A', 'ACTIVE'), player('a', 'B', 'WAITING')], now }), {
      allowed: false, reason: 'DUPLICATE_PLAYER',
    });
  });

  test('resume normalizes waiting state and clears invincibility only for Safety overrides', () => {
    for (const status of ['WAITING', 'EMERGENCY', 'RETIRED', 'CAPTURED']) {
      const result = resolveAdminPlayerResume({ status });
      assert.equal(result.allowed, true);
      assert.equal(result.changed, true);
      assert.equal(result.status, 'ACTIVE');
      assert.equal(result.waitingUntil, 0);
      assert.equal(result.shinkansenStartTime, null);
      assert.equal(result.invincibleUntil, ['EMERGENCY', 'RETIRED'].includes(status) ? 0 : undefined);
    }
    assert.deepEqual(resolveAdminPlayerResume({ status: 'ACTIVE' }), {
      allowed: true,
      changed: false,
      status: 'ACTIVE',
      waitingUntil: 0,
      shinkansenStartTime: null,
    });
    assert.deepEqual(resolveAdminPlayerResume({ status: 'BROKEN' }), {
      allowed: false, reason: 'INVALID_STATUS',
    });
    assert.deepEqual(resolveAdminPlayerResume(null), {
      allowed: false, reason: 'INVALID_STATUS',
    });
  });
});
