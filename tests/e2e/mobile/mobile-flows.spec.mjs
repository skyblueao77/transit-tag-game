import { expect, test } from '@playwright/test';
import {
  assertMobileInputFontSize,
  assertNoHorizontalOverflow,
  attachMobileTestHooks,
  buildMobileContextOptions,
  resetEmulators,
  seedAdminAccount,
} from './helpers.mjs';

test.describe('モバイル E2E 主要導線（Pixel 7 / iPhone SE）', () => {
  test('全5シナリオ: 管理者初期化・QR -> 招待参加・地図HUD -> 逃走者操作 -> ミッション報告 -> SOS/オフライン/ログアウト', async ({ browser }, testInfo) => {
    test.setTimeout(90_000);

    await resetEmulators();
    const adminCreds = await seedAdminAccount();

    const contextOptions = buildMobileContextOptions(testInfo);
    const adminContext = await browser.newContext(contextOptions);
    const playerContext = await browser.newContext(contextOptions);

    const adminPage = await adminContext.newPage();
    const playerPage = await playerContext.newPage();

    const adminHooks = await attachMobileTestHooks(adminPage);
    const playerHooks = await attachMobileTestHooks(playerPage);

    let joinCode = '';

    try {
      await test.step('1. 管理者ログイン -> クイック初期セットアップ -> 招待QRモーダル前面・16px確認', async () => {
        await adminPage.goto('/#/admin');
        await expect(adminPage.getByRole('heading', { name: '管理者ログイン' })).toBeVisible();
        await assertMobileInputFontSize(adminPage, 'AdminAuthGate');
        await assertNoHorizontalOverflow(adminPage, 'AdminAuthGate');

        await adminPage.locator('#admin-id').fill(adminCreds.identifier);
        await adminPage.locator('#admin-pass').fill(adminCreds.password);
        await adminPage.getByRole('button', { name: 'ログインする' }).click();

        await expect(adminPage.getByRole('heading', { name: '運営管理ダッシュボード' })).toBeVisible({ timeout: 15_000 });
        await assertMobileInputFontSize(adminPage, 'AdminView initial');
        await assertNoHorizontalOverflow(adminPage, 'AdminView initial');

        await adminPage.getByRole('button', { name: /1クリックでゲームを一括初期化する/ }).click();
        await expect(adminPage.getByRole('heading', { name: 'Game Session 状態' })).toBeVisible({ timeout: 20_000 });

        const joinCodeEl = adminPage.locator('section', { hasText: '現在の招待コード' }).locator('code').first();
        await expect(joinCodeEl).toBeVisible();
        joinCode = (await joinCodeEl.textContent())?.trim() ?? '';
        expect(joinCode).toMatch(/^[A-Za-z0-9_-]{16,128}$/);

        // 招待QRモーダルが最前面（z-index >= 3000）で横はみ出しなしに表示されること
        await adminPage.getByRole('button', { name: '招待QR' }).click();
        const qrBackdrop = adminPage.locator('[role="dialog"]', { hasText: '参加用 QRコード' });
        await expect(qrBackdrop).toBeVisible();
        await expect(qrBackdrop).toHaveAttribute('aria-modal', 'true');
        const backdropZIndex = await qrBackdrop.evaluate(el => Number.parseInt(window.getComputedStyle(el).zIndex, 10));
        expect(backdropZIndex).toBeGreaterThanOrEqual(3000);
        await expect(qrBackdrop.getByAltText('参加用QRコード')).toBeVisible();
        await assertNoHorizontalOverflow(adminPage, 'InviteQrModal');
        await qrBackdrop.getByRole('button', { name: 'モーダルを閉じる' }).click();
        await expect(qrBackdrop).toBeHidden();

        // MissionEditModal で 1〜100 の任意整数（例: 35pt）を入力でき、全入力が 16px 以上であること
        await adminPage.getByRole('button', { name: '新規作成' }).click();
        const missionModal = adminPage.locator('[role="dialog"]', { hasText: '新規ミッション作成' });
        await expect(missionModal).toBeVisible();
        await assertMobileInputFontSize(adminPage, 'MissionEditModal');
        const pointsInput = missionModal.locator('#mission-modal-points');
        await pointsInput.fill('35');
        await expect(pointsInput).toHaveValue('35');
        await missionModal.getByRole('button', { name: 'キャンセル' }).click();
        await expect(missionModal).toBeHidden();
      });

      await test.step('2. 招待URL参加（16px・非アンマウント） -> WAITING -> フェーズ開始 -> 地図HUD・カスタムズーム・タブ切替', async () => {
        await playerPage.goto(`/#/?join=${encodeURIComponent(joinCode)}`);
        const joinInput = playerPage.locator('#reg-join-code');
        await expect(joinInput).toHaveValue(joinCode);
        await assertMobileInputFontSize(playerPage, 'SetupView');
        await assertNoHorizontalOverflow(playerPage, 'SetupView');

        await playerPage.locator('#reg-user-id').fill('player01');
        await playerPage.locator('#reg-password').fill('pass1234');
        await playerPage.locator('#player-name').fill('たなか');
        const checkboxes = playerPage.locator('form input[type="checkbox"]');
        await checkboxes.nth(0).check();
        await checkboxes.nth(1).check();

        await playerPage.getByRole('button', { name: 'ゲームに参加する' }).click();
        await expect(playerPage.getByRole('heading', { name: 'WAITING...' })).toBeVisible({ timeout: 20_000 });
        await assertNoHorizontalOverflow(playerPage, 'PRE_GAME Waiting');

        // 管理者側で参加者反映を確認し、DAY 1 を開始＆ミッションランダム配信
        await expect(adminPage.getByText('参加プレイヤー (1名)')).toBeVisible({ timeout: 15_000 });
        await adminPage.getByRole('button', { name: /DAY 1（ゲーム本戦）を開始する/ }).click();
        await adminPage.getByRole('dialog').getByRole('button', { name: '実行する' }).click();

        await adminPage.getByRole('button', { name: /ランダム再選定/ }).click();
        await adminPage.getByRole('dialog').getByRole('button', { name: '配信する' }).click();

        // プレイヤー側で待機画面が解除され、地図とカスタムズームボタンが表示されること
        await expect(playerPage.getByRole('heading', { name: 'WAITING...' })).toBeHidden({ timeout: 20_000 });
        await expect(playerPage.locator('.leaflet-container')).toBeVisible({ timeout: 15_000 });
        await expect(playerPage.locator('.leaflet-control-zoom')).toHaveCount(0);

        const zoomInBtn = playerPage.getByRole('button', { name: '地図を拡大' });
        const zoomOutBtn = playerPage.getByRole('button', { name: '地図を縮小' });
        const recenterBtn = playerPage.getByRole('button', { name: '現在地へ戻る' });
        await expect(zoomInBtn).toBeVisible();
        await expect(zoomOutBtn).toBeVisible();
        await expect(recenterBtn).toBeVisible();
        await zoomInBtn.click();
        await zoomOutBtn.click();
        await recenterBtn.click();
        await assertNoHorizontalOverflow(playerPage, 'MapView');

        // ボトムナビで MISSION と MAP の行き来ができ、横はみ出しがないこと
        await playerPage.locator('nav a', { hasText: 'MISSION' }).click();
        await expect(playerPage.getByText('達成後は必ず写真をLINEグループに送ってください')).toBeVisible({ timeout: 15_000 });
        await assertNoHorizontalOverflow(playerPage, 'MissionView');
        await playerPage.locator('nav a', { hasText: 'MAP' }).click();
        await expect(playerPage.locator('.leaflet-container')).toBeVisible();
      });

      await test.step('3. 逃走者のモバイルHUD操作（特例保護 -> 新幹線 -> +1区間 -> 下車待機）', async () => {
        await playerPage.getByRole('button', { name: /グリーン席/ }).click();
        await expect(playerPage.getByText('グリーン席保護中')).toBeVisible({ timeout: 10_000 });

        await playerPage.getByRole('button', { name: '通常', exact: true }).click();
        await expect(playerPage.getByText('グリーン席保護中')).toBeHidden({ timeout: 10_000 });

        await playerPage.getByRole('button', { name: /新幹線乗車開始/ }).click();
        await expect(playerPage.getByText('🚄 新幹線乗車中')).toBeVisible({ timeout: 10_000 });
        await expect(playerPage.getByText('0 / 無制限')).toBeVisible();

        await playerPage.getByRole('button', { name: '+1区間' }).click();
        await expect(playerPage.getByText('1 / 無制限')).toBeVisible({ timeout: 10_000 });

        await playerPage.getByRole('button', { name: /下車待機/ }).click();
        await expect(playerPage.getByRole('dialog')).toContainText('待機開始');
        await playerPage.getByRole('dialog').getByRole('button', { name: '開始する' }).click();
        await expect(playerPage.getByText(/待機中:/)).toBeVisible({ timeout: 15_000 });
      });

      await test.step('4. ミッション待機ガード -> 管理者復帰 -> ミッション完了報告 & スコア反映', async () => {
        await playerPage.locator('nav a', { hasText: 'MISSION' }).click();
        const blockedBtn = playerPage.getByRole('button', { name: '待機・保護中は報告不可' });
        await expect(blockedBtn).toBeVisible({ timeout: 10_000 });
        await expect(blockedBtn).toBeDisabled();

        // 管理者側で待機状態から復帰させる
        await adminPage.getByRole('button', { name: 'たなかを待機状態から復帰させる' }).click();
        await adminPage.getByRole('dialog').getByRole('button', { name: '復帰させる' }).click();

        const reportBtn = playerPage.getByRole('button', { name: '完了報告を行う' });
        await expect(reportBtn).toBeEnabled({ timeout: 15_000 });
        await reportBtn.click();
        await playerPage.getByRole('dialog').getByRole('button', { name: '完了報告する' }).click();

        await expect(playerPage.getByRole('heading', { name: 'MISSION ACHIEVED!' })).toBeVisible({ timeout: 15_000 });
        const teamAScoreText = await playerPage
          .locator('header .text-center')
          .filter({ hasText: /^A\d+$/ })
          .first()
          .textContent();
        const parsedScore = Number.parseInt((teamAScoreText ?? '').replace(/[^\d]/g, ''), 10);
        expect(parsedScore).toBeGreaterThan(0);
      });

      await test.step('5. SOS緊急発信 -> オフラインバナー表示/復帰 -> ヘッダーログアウト', async () => {
        await playerPage.getByRole('button', { name: 'SOS / リタイア' }).click();
        const safetyDialog = playerPage.getByRole('dialog', { name: 'Safety Action' });
        await expect(safetyDialog).toBeVisible();
        await safetyDialog.getByRole('button', { name: '機材トラブル' }).click();
        await expect(safetyDialog).toBeHidden({ timeout: 15_000 });

        await expect(adminPage.getByText('EMERGENCY').first()).toBeVisible({ timeout: 15_000 });
        await assertNoHorizontalOverflow(adminPage, 'AdminView EMERGENCY');

        // オフライン遷移 -> 統合バナー表示 -> オンライン復帰で解除
        playerHooks.setAllowOfflineErrors(true);
        await playerContext.setOffline(true);
        await expect(playerPage.getByText('通信断：オフラインモード（位置更新を一時停止中）')).toBeVisible({ timeout: 10_000 });
        await playerContext.setOffline(false);
        await expect(playerPage.getByText('通信断：オフラインモード（位置更新を一時停止中）')).toBeHidden({ timeout: 15_000 });
        await playerPage.waitForTimeout(500);
        playerHooks.setAllowOfflineErrors(false);

        // ヘッダーログアウトで参加画面へ戻れること
        await playerPage.getByRole('button', { name: 'ログアウト' }).click();
        await playerPage.getByRole('dialog').getByRole('button', { name: 'ログアウト' }).click();
        await expect(playerPage.getByRole('button', { name: /新規エントリー/ })).toBeVisible({ timeout: 15_000 });
      });

      expect(adminHooks.errors).toEqual([]);
      expect(playerHooks.errors).toEqual([]);
    } finally {
      await adminContext.close();
      await playerContext.close();
    }
  });
});
