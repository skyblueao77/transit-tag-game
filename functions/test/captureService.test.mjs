import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  capturePlayerForPlayer,
  CaptureServiceError,
} from '../lib/functions/src/capture/captureService.js';

const fixedTime = 1_700_000_000_000;

function user(id, team, overrides = {}) {
  return {
    id,
    data: {
      id,
      team,
      name: id,
      status: 'ACTIVE',
      invincibleCards: 0,
      invincibleUntil: 0,
      ...overrides,
    },
  };
}

function fixture(overrides = {}) {
  const state = {
    config: {
      gameStatus: 'DAY1_ACTIVE',
      teamARole: 'ONI',
      teamBRole: 'RUNNER',
      teamAScore: 10,
      teamBScore: 20,
      nextRevealTime: 0,
      logs: [],
    },
    users: [
      user('oni-a', 'A'),
      user('oni-a2', 'A', { invincibleCards: 2 }),
      user('runner-b', 'B', { invincibleUntil: 123 }),
      user('runner-b2', 'B'),
      user('admin', 'ADMIN'),
    ],
    writes: [],
    writeCalls: 0,
    ...overrides,
  };
  const store = {
    async runTransaction(work) {
      let pendingWrite;
      const transaction = {
        readGameConfig: async () => state.config,
        readUsers: async () => state.users,
        writeCapture: write => {
          state.writeCalls += 1;
          pendingWrite = structuredClone(write);
        },
      };
      const result = await work(transaction);
      if (pendingWrite) state.writes.push(pendingWrite);
      return result;
    },
  };
  return { state, store };
}

function runtime(now = fixedTime) {
  let nowCalls = 0;
  let idCalls = 0;
  return {
    now: () => { nowCalls += 1; return now; },
    createLogId: () => { idCalls += 1; return 'capture-log-1'; },
    calls: () => ({ nowCalls, idCalls }),
  };
}

async function rejectsWith(reason, domainReason, callback) {
  await assert.rejects(callback, error => {
    assert.ok(error instanceof CaptureServiceError);
    assert.equal(error.reason, reason);
    assert.equal(error.domainReason, domainReason);
    return true;
  });
}

async function assertNoWrites(data, uid = 'oni-a', targetId = 'runner-b') {
  await assert.rejects(
    capturePlayerForPlayer(uid, targetId, data.store, runtime()),
    CaptureServiceError,
  );
  assert.equal(data.state.writeCalls, 0);
  assert.equal(data.state.writes.length, 0);
}

describe('server Capture service', () => {
  test('rejects missing captor and target without authoritative writes', async () => {
    const missingCaptor = fixture({ users: [user('runner-b', 'B')] });
    await rejectsWith('PLAYER_NOT_FOUND', undefined, () => capturePlayerForPlayer(
      'missing-captor', 'runner-b', missingCaptor.store, runtime(),
    ));
    assert.equal(missingCaptor.state.writeCalls, 0);

    const missingTarget = fixture();
    await rejectsWith('TARGET_NOT_FOUND', undefined, () => capturePlayerForPlayer(
      'oni-a', 'missing-target', missingTarget.store, runtime(),
    ));
    assert.equal(missingTarget.state.writeCalls, 0);
  });

  test('validates target ids before opening a transaction', async () => {
    const data = fixture();
    for (const targetId of ['', '  ', '../other', 'nested/target', '.', '..', 'x'.repeat(129)]) {
      await rejectsWith('INVALID_ARGUMENT', undefined, () => capturePlayerForPlayer(
        'oni-a', targetId, data.store, runtime(),
      ));
    }
    assert.equal(data.state.writeCalls, 0);
  });

  test('rejects invalid phase, identity, team, role, status, and invincibility without writes', async () => {
    const cases = [
      [fixture({ config: { ...fixture().state.config, gameStatus: 'DAY1_PAUSED' } }), 'oni-a', 'runner-b', 'CAPTURE_REJECTED', 'PHASE'],
      [fixture(), 'oni-a', 'oni-a', 'CAPTURE_REJECTED', 'SAME_PLAYER'],
      [fixture(), 'oni-a', 'oni-a2', 'CAPTURE_REJECTED', 'SAME_TEAM'],
      [fixture({ config: { ...fixture().state.config, teamARole: 'RUNNER' } }), 'oni-a', 'runner-b', 'CAPTURE_REJECTED', 'CAPTOR_ROLE'],
      [fixture({ config: { ...fixture().state.config, teamBRole: 'ONI' } }), 'oni-a', 'runner-b', 'CAPTURE_REJECTED', 'TARGET_ROLE'],
      [fixture({ users: [user('oni-a', 'A', { status: 'WAITING' }), user('runner-b', 'B')] }), 'oni-a', 'runner-b', 'CAPTURE_REJECTED', 'CAPTOR_STATUS'],
      [fixture({ users: [user('oni-a', 'A'), user('runner-b', 'B', { status: 'WAITING' })] }), 'oni-a', 'runner-b', 'CAPTURE_REJECTED', 'TARGET_STATUS'],
      [fixture({ users: [user('oni-a', 'A'), user('runner-b', 'B', { invincibleUntil: fixedTime + 1 })] }), 'oni-a', 'runner-b', 'CAPTURE_REJECTED', 'TARGET_INVINCIBLE'],
    ];

    for (const [data, uid, targetId, reason, domainReason] of cases) {
      await rejectsWith(reason, domainReason, () => capturePlayerForPlayer(
        uid, targetId, data.store, runtime(),
      ));
      assert.equal(data.state.writeCalls, 0, domainReason);
      assert.equal(data.state.writes.length, 0, domainReason);
    }
  });

  test('rejects ADMIN and unknown-team captors and targets at the trusted boundary', async () => {
    for (const [captor, targetId, reason] of [
      ['admin', 'runner-b', 'INVALID_CAPTOR_TEAM'],
      ['unknown-captor', 'runner-b', 'INVALID_CAPTOR_TEAM'],
    ]) {
      const data = fixture({ users: [
        ...fixture().state.users,
        ...(captor === 'unknown-captor' ? [user(captor, 'C')] : []),
      ] });
      await rejectsWith(reason, undefined, () => capturePlayerForPlayer(
        captor, targetId, data.store, runtime(),
      ));
      assert.equal(data.state.writeCalls, 0);
    }

    for (const [target, team] of [['admin', 'ADMIN'], ['unknown-target', 'C']]) {
      const data = fixture({ users: [
        ...fixture().state.users,
        ...(target === 'unknown-target' ? [user(target, team)] : []),
      ] });
      await rejectsWith('INVALID_TARGET_TEAM', undefined, () => capturePlayerForPlayer(
        'oni-a', target, data.store, runtime(),
      ));
      assert.equal(data.state.writeCalls, 0);
    }
  });

  test('rejects malformed trusted participant and config state without writes', async () => {
    const malformedPlayer = fixture({ users: [
      user('oni-a', 'A', { invincibleCards: -1 }),
      user('runner-b', 'B'),
    ] });
    await rejectsWith('INVALID_GAME_STATE', undefined, () => capturePlayerForPlayer(
      'oni-a', 'runner-b', malformedPlayer.store, runtime(),
    ));
    assert.equal(malformedPlayer.state.writeCalls, 0);

    const malformedConfig = fixture({ config: {
      ...fixture().state.config,
      teamARole: 'UNKNOWN',
    } });
    await rejectsWith('INVALID_GAME_STATE', undefined, () => capturePlayerForPlayer(
      'oni-a', 'runner-b', malformedConfig.store, runtime(),
    ));
    assert.equal(malformedConfig.state.writeCalls, 0);
  });

  test('uses Game Core for active phases and preserves its full success result', async () => {
    for (const phase of ['DAY1_ACTIVE', 'DAY2_ACTIVE', 'FINAL_MISSION']) {
      const data = fixture({ config: { ...fixture().state.config, gameStatus: phase } });
      const result = await capturePlayerForPlayer(
        'oni-a', 'runner-b', data.store, runtime(),
      );
      assert.equal(result.ok, true);
      assert.deepEqual(result.capture.reward, { team: 'A', scoreDelta: 50 });
      assert.deepEqual(result.capture.teamRoles, { teamARole: 'RUNNER', teamBRole: 'ONI' });
      assert.equal(result.capture.nextRevealTime, fixedTime + result.capture.waitingDuration);
      assert.equal(data.state.writeCalls, 1);
      assert.equal(data.state.writes.length, 1);
    }
  });

  test('persists Core player changes, reward, roles, deadline, and server log once', async () => {
    const oldLogs = Array.from({ length: 199 }, (_, index) => ({ id: `old-${index}` }));
    const data = fixture({
      config: { ...fixture().state.config, logs: oldLogs },
      users: [
        user('oni-a', 'A', { score: 80 }),
        user('oni-a2', 'A', { invincibleCards: 2, score: 90 }),
        user('runner-b', 'B', { invincibleUntil: 123, score: 100 }),
        user('runner-b2', 'B', { invincibleUntil: 456, score: 110 }),
        user('admin', 'ADMIN', { score: 999 }),
      ],
    });
    const usersBefore = structuredClone(data.state.users);
    const result = await capturePlayerForPlayer(
      'oni-a', 'runner-b', data.store, runtime(),
    );
    const write = data.state.writes[0];

    assert.deepEqual(result.capture.playerChanges, [
      { playerId: 'oni-a', status: 'ACTIVE', waitingUntil: 0, invincibleCardsDelta: 1 },
      { playerId: 'oni-a2', status: 'ACTIVE', waitingUntil: 0, invincibleCardsDelta: 1 },
      {
        playerId: 'runner-b', status: 'WAITING', waitingUntil: fixedTime + 30 * 60 * 1000,
        invincibleUntil: 0, invincibleCardsDelta: 0,
      },
      {
        playerId: 'runner-b2', status: 'WAITING', waitingUntil: fixedTime + 30 * 60 * 1000,
        invincibleUntil: 0, invincibleCardsDelta: 0,
      },
    ]);
    assert.equal(write.capture.reward.scoreDelta, 50);
    assert.equal(write.teamScoreField, 'teamAScore');
    assert.deepEqual(write.capture.teamRoles, { teamARole: 'RUNNER', teamBRole: 'ONI' });
    assert.equal(write.capture.nextRevealTime, fixedTime + 30 * 60 * 1000);
    assert.equal(write.logs.length, 200);
    assert.equal(write.logs[0].id, 'capture-log-1');
    assert.equal(write.logs[0].timestamp, fixedTime);
    assert.match(write.logs[0].message, /^07:13 Team A が捕獲成功！攻守交代 \(\+50pt\)$/);
    assert.equal(write.logs[0].type, 'CAPTURE');
    assert.deepEqual(data.state.users, usersBefore);
    assert.equal(write.capture.playerChanges.some(change => change.playerId === 'admin'), false);
  });

  test('caps logs at 200 and does not mutate the trusted inputs', async () => {
    const logs = Array.from({ length: 205 }, (_, index) => ({ id: `old-${index}` }));
    const data = fixture({ config: { ...fixture().state.config, logs } });
    const configBefore = structuredClone(data.state.config);
    const usersBefore = structuredClone(data.state.users);
    await capturePlayerForPlayer('oni-a', 'runner-b', data.store, runtime());

    assert.equal(data.state.writes[0].logs.length, 200);
    assert.equal(data.state.writes[0].logs[0].id, 'capture-log-1');
    assert.deepEqual(data.state.config, configBefore);
    assert.deepEqual(data.state.users, usersBefore);
  });

  test('fixes request clock and log id outside transaction retries', async () => {
    const data = fixture();
    const runtimeStub = runtime(1_700_000_123_000);
    const writes = [];
    const retryingStore = {
      async runTransaction(work) {
        let result;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let pending;
          result = await work({
            readGameConfig: async () => data.state.config,
            readUsers: async () => data.state.users,
            writeCapture: write => { pending = structuredClone(write); },
          });
          writes.push(pending);
        }
        return result;
      },
    };

    await capturePlayerForPlayer('oni-a', 'runner-b', retryingStore, runtimeStub);
    assert.deepEqual(runtimeStub.calls(), { nowCalls: 1, idCalls: 1 });
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(writes[0].logs[0].timestamp, 1_700_000_123_000);
    assert.equal(
      writes[0].capture.nextRevealTime,
      1_700_000_123_000 + writes[0].capture.waitingDuration,
    );
  });

  test('maps transaction failures without returning a successful result', async () => {
    const brokenStore = { runTransaction: async () => { throw new Error('private firestore path'); } };
    await rejectsWith('PERSISTENCE_ERROR', undefined, () => capturePlayerForPlayer(
      'oni-a', 'runner-b', brokenStore, runtime(),
    ));
  });
});
