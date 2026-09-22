import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getPlayerRole } from '../../src/game/roles.ts';

const roles = { teamARole: 'ONI', teamBRole: 'RUNNER' };

 describe('getPlayerRole', () => {
  test('resolves Team A as ONI when Team A is ONI', () => {
    assert.equal(getPlayerRole({ team: 'A' }, roles), 'ONI');
  });

  test('resolves Team A as RUNNER when Team A is RUNNER', () => {
    assert.equal(getPlayerRole({ team: 'A' }, { teamARole: 'RUNNER', teamBRole: 'ONI' }), 'RUNNER');
  });

  test('resolves Team B as ONI when Team B is ONI', () => {
    assert.equal(getPlayerRole({ team: 'B' }, { teamARole: 'RUNNER', teamBRole: 'ONI' }), 'ONI');
  });

  test('resolves Team B as RUNNER when Team B is RUNNER', () => {
    assert.equal(getPlayerRole({ team: 'B' }, roles), 'RUNNER');
  });

  test('preserves the existing ADMIN special case', () => {
    assert.equal(getPlayerRole({ team: 'ADMIN' }, roles), 'ONI');
  });
});
