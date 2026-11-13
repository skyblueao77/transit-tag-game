import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  computeTeammateSplitMetrics,
  TEAM_SPLIT_ALERT_THRESHOLD_METERS,
} from '../../src/game/locationThrottling.ts';

const NOW = 1_700_000_000_000;
const TOKYO_STATION = { latitude: 35.681236, longitude: 139.767125 };
const SHINAGAWA_STATION = { latitude: 35.628471, longitude: 139.73876 }; // ~6.4km south
const YURAKUCHO_STATION = { latitude: 35.675069, longitude: 139.763328 }; // ~770m south

describe('Teammate split distance metrics', () => {
  test('returns zero and no alert when privateLocation or team is missing', () => {
    assert.deepEqual(
      computeTeammateSplitMetrics({
        currentUserId: 'a1',
        currentUserTeam: 'A',
        myCoords: null,
        users: [{ id: 'a2', team: 'A', status: 'ACTIVE' }],
        exposedLocations: { a2: { ...SHINAGAWA_STATION, expiresAt: NOW + 60_000 } },
        nowMs: NOW,
      }),
      { maxTeammateDistance: 0, isTeamSplitAlert: false },
    );

    assert.deepEqual(
      computeTeammateSplitMetrics({
        currentUserId: 'admin',
        currentUserTeam: '',
        myCoords: TOKYO_STATION,
        users: [{ id: 'a2', team: 'A', status: 'ACTIVE' }],
        exposedLocations: { a2: { ...SHINAGAWA_STATION, expiresAt: NOW + 60_000 } },
        nowMs: NOW,
      }),
      { maxTeammateDistance: 0, isTeamSplitAlert: false },
    );
  });

  test('ignores expired exposed snapshots so stale locations do not trigger alerts', () => {
    const result = computeTeammateSplitMetrics({
      currentUserId: 'a1',
      currentUserTeam: 'A',
      myCoords: TOKYO_STATION,
      users: [
        { id: 'a1', team: 'A', status: 'ACTIVE' },
        { id: 'a2', team: 'A', status: 'ACTIVE' },
      ],
      exposedLocations: {
        a2: { ...SHINAGAWA_STATION, expiresAt: NOW - 1000 },
      },
      nowMs: NOW,
    });

    assert.equal(result.maxTeammateDistance, 0);
    assert.equal(result.isTeamSplitAlert, false);
  });

  test('ignores opposing team and non-ACTIVE teammates', () => {
    const result = computeTeammateSplitMetrics({
      currentUserId: 'a1',
      currentUserTeam: 'A',
      myCoords: TOKYO_STATION,
      users: [
        { id: 'a2', team: 'A', status: 'WAITING' },
        { id: 'a3', team: 'A', status: 'RETIRED' },
        { id: 'b1', team: 'B', status: 'ACTIVE' },
      ],
      exposedLocations: {
        a2: { ...SHINAGAWA_STATION, expiresAt: NOW + 60_000 },
        a3: { ...SHINAGAWA_STATION, expiresAt: NOW + 60_000 },
        b1: { ...SHINAGAWA_STATION, expiresAt: NOW + 60_000 },
      },
      nowMs: NOW,
    });

    assert.equal(result.maxTeammateDistance, 0);
    assert.equal(result.isTeamSplitAlert, false);
  });

  test('computes max distance among active teammates and triggers alert above threshold', () => {
    const closeResult = computeTeammateSplitMetrics({
      currentUserId: 'a1',
      currentUserTeam: 'A',
      myCoords: TOKYO_STATION,
      users: [{ id: 'a2', team: 'A', status: 'ACTIVE' }],
      exposedLocations: {
        a2: { ...YURAKUCHO_STATION, expiresAt: NOW + 60_000 },
      },
      nowMs: NOW,
    });

    assert.ok(closeResult.maxTeammateDistance > 500 && closeResult.maxTeammateDistance < TEAM_SPLIT_ALERT_THRESHOLD_METERS);
    assert.equal(closeResult.isTeamSplitAlert, false);

    const farResult = computeTeammateSplitMetrics({
      currentUserId: 'a1',
      currentUserTeam: 'A',
      myCoords: TOKYO_STATION,
      users: [
        { id: 'a2', team: 'A', status: 'ACTIVE' },
        { id: 'a3', team: 'A', status: 'ACTIVE' },
      ],
      exposedLocations: {
        a2: { ...YURAKUCHO_STATION, expiresAt: NOW + 60_000 },
        a3: { ...SHINAGAWA_STATION, expiresAt: NOW + 60_000 },
      },
      nowMs: NOW,
    });

    assert.ok(farResult.maxTeammateDistance > 5000);
    assert.equal(farResult.isTeamSplitAlert, true);
  });
});
