import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { INITIAL_GAME_CONFIG } from '../constants.ts';
import { closeViteSsrServer, renderSsrComponent } from './helpers/viteSsrLoader.mjs';

after(async () => {
  await closeViteSsrServer();
});

function makeConfig(overrides = {}) {
  return {
    ...INITIAL_GAME_CONFIG,
    gameSessionId: 'session-admin-1',
    gameStatus: 'DAY1_ACTIVE',
    ...overrides,
  };
}

describe('Admin view extracted UI components', () => {
  test('AdminSessionSetupSection switches between setup wizard and active session card', async () => {
    const initialHtml = await renderSsrComponent('/views/admin/AdminSessionSetupSection.tsx', {
      gameSessionId: undefined,
      sessionInitializationBusy: false,
      isProcessing: false,
      onQuickSetupWizard: () => {},
      onInitializeGameSession: () => {},
    });

    assert.match(initialHtml, /1クリック初期セットアップ/);
    assert.match(initialHtml, /1クリックでゲームを一括初期化する/);

    const activeHtml = await renderSsrComponent('/views/admin/AdminSessionSetupSection.tsx', {
      gameSessionId: 'session-xyz',
      sessionInitializationBusy: false,
      isProcessing: true,
      onQuickSetupWizard: () => {},
      onInitializeGameSession: () => {},
    });

    assert.match(activeHtml, /Game Session 状態/);
    assert.match(activeHtml, /session-xyz/);
    assert.match(activeHtml, /<button[^>]*disabled=""/);
  });

  test('AdminRoleSwapSection renders team roles and disables button while processing', async () => {
    const html = await renderSsrComponent('/views/admin/AdminRoleSwapSection.tsx', {
      teamARole: 'ONI',
      teamBRole: 'RUNNER',
      isProcessing: true,
      onForceRoleSwap: () => {},
    });

    assert.match(html, /Team A: 👹 鬼/);
    assert.match(html, /Team B: 🏃 逃走者/);
    assert.match(html, /<button[^>]*disabled=""/);
  });

  test('AdminRuleSettingsSection enforces gateway-aligned numeric bounds and reflects config mode', async () => {
    const html = await renderSsrComponent('/views/admin/AdminRuleSettingsSection.tsx', {
      config: makeConfig({ victoryMode: 'SCORE_SWAP' }),
      requireSessionId: () => 'session-admin-1',
    });

    assert.match(html, /🏆 ポイント交代制/);
    // postShinkansenWaitMinutes: min 1, max 180
    assert.match(html, /min="1"[^>]*max="180"[^>]*step="5"/);
    // periodicRevealIntervalMinutes: min 5, max 120
    assert.match(html, /min="5"[^>]*max="120"[^>]*step="5"/);
    // shinkansenMaxMinutes: min 0, max 600
    assert.match(html, /min="0"[^>]*max="600"/);
    // shinkansenMaxSegments: min 0, max 50
    assert.match(html, /min="0"[^>]*max="50"/);
  });

  test('AdminPhaseControlSection renders phase-specific controls', async () => {
    const preGameHtml = await renderSsrComponent('/views/admin/AdminPhaseControlSection.tsx', {
      gameStatus: 'PRE_GAME',
      phaseLabel: '開始前',
      isProcessing: false,
      onPhaseAction: () => {},
    });
    assert.match(preGameHtml, /DAY 1（ゲーム本戦）を開始する/);

    const gameOverHtml = await renderSsrComponent('/views/admin/AdminPhaseControlSection.tsx', {
      gameStatus: 'GAME_OVER',
      phaseLabel: 'ゲーム終了',
      isProcessing: false,
      onPhaseAction: () => {},
    });
    assert.match(gameOverHtml, /マスターリセットから新しいセッションを開始できます/);
  });

  test('AdminBroadcastSection disables submit when input is empty or whitespace', async () => {
    const emptyHtml = await renderSsrComponent('/views/admin/AdminBroadcastSection.tsx', {
      broadcastInput: '   ',
      isSendingBroadcast: false,
      onChangeBroadcastInput: () => {},
      onSubmitBroadcast: () => {},
    });
    assert.match(emptyHtml, /<button[^>]*type="submit"[^>]*\sdisabled=""/);

    const filledHtml = await renderSsrComponent('/views/admin/AdminBroadcastSection.tsx', {
      broadcastInput: '中間報告を実施します',
      isSendingBroadcast: false,
      onChangeBroadcastInput: () => {},
      onSubmitBroadcast: () => {},
    });
    assert.doesNotMatch(filledHtml, /<button[^>]*type="submit"[^>]*\sdisabled=""/);
  });

  test('AdminLocationRevealSection excludes non-participant admins from penalty selector', async () => {
    const html = await renderSsrComponent('/views/admin/AdminLocationRevealSection.tsx', {
      config: makeConfig(),
      users: [
        { id: 'admin-1', name: '運営太郎', team: 'ADMIN', color: '#000', score: 0, status: 'ACTIVE' },
        { id: 'a1', name: '参加者A', team: 'A', color: '#ef4444', score: 10, status: 'ACTIVE' },
        { id: 'b1', name: '参加者B', team: 'B', color: '#3b82f6', score: 20, status: 'ACTIVE' },
      ],
      searchDuration: 10,
      penaltyTargetPlayerId: '',
      penaltyDurationMinutes: 10,
      isProcessing: false,
      isApplyingPenalty: false,
      onChangeSearchDuration: () => {},
      onLocationReveal: () => {},
      onChangePenaltyTargetPlayerId: () => {},
      onChangePenaltyDurationMinutes: () => {},
      onApplyPenalty: () => {},
    });

    assert.doesNotMatch(html, /運営太郎/);
    assert.match(html, /参加者A \(Team A - RUNNER\)/);
    assert.match(html, /参加者B \(Team B - ONI\)/);
  });
});
