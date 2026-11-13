import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { INITIAL_GAME_CONFIG } from '../constants.ts';
import { closeViteSsrServer, renderSsrComponent } from './helpers/viteSsrLoader.mjs';

after(async () => {
  await closeViteSsrServer();
});

const formatTime = sec => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

function makeUser(overrides = {}) {
  return {
    id: 'user-1',
    name: 'テスト太郎',
    team: 'A',
    color: '#ef4444',
    score: 0,
    status: 'ACTIVE',
    invincibleCards: 1,
    protectionZone: 'NONE',
    shinkansenSegmentCount: 0,
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    ...INITIAL_GAME_CONFIG,
    gameSessionId: 'session-1',
    gameStatus: 'DAY1_ACTIVE',
    ...overrides,
  };
}

function makeTimeLeft(overrides = {}) {
  return {
    waiting: 0,
    invincible: 0,
    nextReveal: 0,
    final: 0,
    oniLock: 0,
    shinkansenRemaining: 0,
    forceReveal: 0,
    teamSearchRemaining: 0,
    penaltyRemaining: 0,
    ...overrides,
  };
}

describe('Map view extracted UI components', () => {
  test('OniWaitingOverlay renders lock countdown and initial wait minutes', async () => {
    const html = await renderSsrComponent('/views/map/OniWaitingOverlay.tsx', {
      remainingSeconds: 125,
      formatTime,
    });

    assert.match(html, /ONI WAITING\.\.\./);
    assert.match(html, /2:05/);
    assert.match(html, /30分間/);
  });

  test('MapStatusHeader respects banner priority order and renders offline/team-split alerts', async () => {
    const html = await renderSsrComponent('/views/map/MapStatusHeader.tsx', {
      isOffline: true,
      timeLeft: makeTimeLeft({
        penaltyRemaining: 90,
        teamSearchRemaining: 60,
        forceReveal: 30,
        nextReveal: 15,
      }),
      gameConfig: makeConfig(),
      isTeamSplitAlert: true,
      maxTeammateDistance: 2300,
      formatTime,
    });

    assert.match(html, /通信断：位置更新を一時停止中/);
    assert.match(html, /【ペナルティ】位置情報常時公開中！ 残り 1:30/);
    assert.doesNotMatch(html, /チーム位置スナップショット公開中/);
    assert.match(html, /【同一行動規定】チームメンバーと離れすぎています/);
  });

  test('MapStatusBadges renders active status badges and hides shinkansen badge when not ACTIVE', async () => {
    const activeHtml = await renderSsrComponent('/views/map/MapStatusBadges.tsx', {
      currentUser: makeUser({
        lastStation: '東京 (JR山手線)',
        protectionZone: 'GREEN_CAR',
        status: 'ACTIVE',
      }),
      timeLeft: makeTimeLeft({
        invincible: 120,
        waiting: 45,
        shinkansenRemaining: 600,
      }),
      formatTime,
    });

    assert.match(activeHtml, /東京 \(JR山手線\)/);
    assert.match(activeHtml, /グリーン席保護中/);
    assert.match(activeHtml, /無敵中: 2:00/);
    assert.match(activeHtml, /待機中: 0:45/);
    assert.match(activeHtml, /新幹線移動: 10:00/);

    const waitingHtml = await renderSsrComponent('/views/map/MapStatusBadges.tsx', {
      currentUser: makeUser({ status: 'WAITING', protectionZone: 'SAFE_ZONE' }),
      timeLeft: makeTimeLeft({ shinkansenRemaining: 600 }),
      formatTime,
    });

    assert.match(waitingHtml, /セーフゾーン中/);
    assert.doesNotMatch(waitingHtml, /新幹線移動:/);
  });

  test('MapOniCapturePanel disables capture when target is protected or game/player is inactive', async () => {
    const protectedHtml = await renderSsrComponent('/views/map/MapOniCapturePanel.tsx', {
      currentUser: makeUser({ status: 'ACTIVE' }),
      gameConfig: makeConfig({ gameStatus: 'DAY1_ACTIVE' }),
      captureCandidates: [makeUser({ id: 'runner-1', name: '逃走者1', protectionZone: 'GREEN_CAR' })],
      selectedTargetId: 'runner-1',
      isProcessing: false,
      onSelectTarget: () => {},
      onCapture: async () => {},
    });

    assert.match(protectedHtml, /特例保護エリア宣言中のため捕獲不可/);
    assert.match(protectedHtml, /<button[^>]*disabled=""/);

    const pausedHtml = await renderSsrComponent('/views/map/MapOniCapturePanel.tsx', {
      currentUser: makeUser({ status: 'ACTIVE' }),
      gameConfig: makeConfig({ gameStatus: 'DAY1_PAUSED' }),
      captureCandidates: [makeUser({ id: 'runner-1', name: '逃走者1', protectionZone: 'NONE' })],
      selectedTargetId: 'runner-1',
      isProcessing: false,
      onSelectTarget: () => {},
      onCapture: async () => {},
    });

    assert.match(pausedHtml, /捕獲ボタン/);
    assert.match(pausedHtml, /<button[^>]*disabled=""/);

    const readyHtml = await renderSsrComponent('/views/map/MapOniCapturePanel.tsx', {
      currentUser: makeUser({ status: 'ACTIVE' }),
      gameConfig: makeConfig({ gameStatus: 'DAY1_ACTIVE' }),
      captureCandidates: [makeUser({ id: 'runner-1', name: '逃走者1', protectionZone: 'NONE' })],
      selectedTargetId: 'runner-1',
      isProcessing: false,
      onSelectTarget: () => {},
      onCapture: async () => {},
    });

    assert.match(readyHtml, /<button type="button" class="px-10 py-4 rounded-full font-black text-lg shadow-2xl transition-all bg-slate-900/);
    assert.doesNotMatch(readyHtml, /<button[^>]*disabled/);
  });

  test('MapRunnerControls enforces phase/status guards and 60s shinkansen cancel visibility', async () => {
    const now = 1_700_000_000_000;
    const shinkansenCancelHtml = await renderSsrComponent('/views/map/MapRunnerControls.tsx', {
      currentUser: makeUser({
        status: 'ACTIVE',
        shinkansenStartTime: now - 30_000,
        shinkansenSegmentCount: 0,
      }),
      gameConfig: makeConfig({ gameStatus: 'DAY1_ACTIVE', postShinkansenWaitMinutes: 45 }),
      timeLeft: makeTimeLeft({ shinkansenRemaining: 3600 }),
      nowMs: now,
      isProcessing: false,
      setIsProcessing: () => {},
      formatTime,
      onActivateInvincibility: async () => {},
      onStartShinkansenWait: async () => {},
      onResetShinkansen: async () => {},
    });

    assert.match(shinkansenCancelHtml, /取消\(60秒以内\)/);
    assert.match(shinkansenCancelHtml, /下車待機（45分）開始/);

    const afterSegmentHtml = await renderSsrComponent('/views/map/MapRunnerControls.tsx', {
      currentUser: makeUser({
        status: 'ACTIVE',
        shinkansenStartTime: now - 30_000,
        shinkansenSegmentCount: 1,
      }),
      gameConfig: makeConfig({ gameStatus: 'DAY1_ACTIVE', shinkansenMaxSegments: 1 }),
      timeLeft: makeTimeLeft({ shinkansenRemaining: 3600 }),
      nowMs: now,
      isProcessing: false,
      setIsProcessing: () => {},
      formatTime,
      onActivateInvincibility: async () => {},
      onStartShinkansenWait: async () => {},
      onResetShinkansen: async () => {},
    });

    assert.doesNotMatch(afterSegmentHtml, /取消\(60秒以内\)/);
    assert.match(afterSegmentHtml, /新幹線利用上限/);

    const preGameHtml = await renderSsrComponent('/views/map/MapRunnerControls.tsx', {
      currentUser: makeUser({ status: 'ACTIVE', invincibleCards: 2 }),
      gameConfig: makeConfig({ gameStatus: 'PRE_GAME' }),
      timeLeft: makeTimeLeft(),
      nowMs: now,
      isProcessing: false,
      setIsProcessing: () => {},
      formatTime,
      onActivateInvincibility: async () => {},
      onStartShinkansenWait: async () => {},
    });

    const buttons = [...preGameHtml.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
    assert.equal(buttons.length, 6);
    assert.ok(buttons.every(tag => tag.includes('disabled=""')), 'all runner controls must be disabled during PRE_GAME');
  });
});
