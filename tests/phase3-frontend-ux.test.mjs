import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { closeViteSsrServer, loadSsrModule } from './helpers/viteSsrLoader.mjs';

after(async () => {
  await closeViteSsrServer();
});

describe('Phase 3: Frontend stability, performance & UX', () => {
  test('ErrorBoundary renders children normally, builds formatted error report, and falls back with SOS guidance on error', async () => {
    const { ErrorBoundary, formatErrorReport } = await loadSsrModule('/src/components/ui/ErrorBoundary.tsx');

    const report = formatErrorReport(new Error('ChunkLoadError: boom'), '  at MapView\n  at App', 'https://example.com/#/map');
    assert.match(report, /\[Transit Tag Error Report\]/);
    assert.match(report, /Error: Error: ChunkLoadError: boom/);
    assert.match(report, /URL: https:\/\/example\.com\/#\/map/);
    assert.match(report, /Component Stack:/);

    const normalHtml = renderToStaticMarkup(
      React.createElement(ErrorBoundary, { scope: 'route', resetKey: '/map' }, React.createElement('div', null, '正常表示')),
    );
    assert.match(normalHtml, /正常表示/);

    const fallbackState = ErrorBoundary.getDerivedStateFromError(new Error('Render crash'));
    assert.equal(fallbackState.hasError, true);
    assert.equal(fallbackState.error?.message, 'Render crash');

    const boundary = new ErrorBoundary({ scope: 'route', resetKey: '/map', children: null });
    boundary.state = {
      hasError: true,
      error: new Error('Render crash'),
      componentStack: 'at MapView',
      showDetails: true,
      copied: false,
    };
    const fallbackHtml = renderToStaticMarkup(boundary.render());
    assert.match(fallbackHtml, /119番.*110番/);
    assert.match(fallbackHtml, /ページを再読み込み/);
    assert.match(fallbackHtml, /マップへ戻る/);
    assert.match(fallbackHtml, /エラー詳細をコピー/);
    assert.match(fallbackHtml, /Render crash/);
  });

  test('resolveNextAutoExposeTickDelayMs schedules re-expose ticks for >58m penalty/global reveals even without periodic reveal', async () => {
    const { resolveNextAutoExposeTickDelayMs } = await loadSsrModule('/src/hooks/usePlayerAutoExpose.ts');
    const now = 1_800_000_000_000;

    // 90-minute penalty without existing snapshot -> schedules snapshot refresh lead tick (<= 60s polling cap)
    const initialDelay = resolveNextAutoExposeTickDelayMs({
      now,
      gameConfig: {
        gameStatus: 'DAY1_ACTIVE',
        startTime: undefined,
        periodicRevealIntervalMinutes: undefined,
        periodicRevealDurationMinutes: undefined,
        locationRevealUntil: undefined,
        teamARevealUntil: undefined,
        teamBRevealUntil: undefined,
      },
      currentUser: {
        team: 'A',
        penaltyRevealUntil: now + 90 * 60_000,
      },
      existingExposed: null,
    });
    assert.ok(typeof initialDelay === 'number' && initialDelay > 0 && initialDelay <= 60_000);

    // Existing 58-min capped snapshot nearing 30-min refresh threshold -> schedules tick close to threshold (1s..60s)
    const refreshDelay = resolveNextAutoExposeTickDelayMs({
      now,
      gameConfig: {
        gameStatus: 'DAY1_ACTIVE',
        startTime: undefined,
        periodicRevealIntervalMinutes: undefined,
        periodicRevealDurationMinutes: undefined,
        locationRevealUntil: undefined,
        teamARevealUntil: undefined,
        teamBRevealUntil: undefined,
      },
      currentUser: {
        team: 'A',
        penaltyRevealUntil: now + 90 * 60_000,
      },
      existingExposed: {
        expiresAt: now + 30 * 60_000 + 5_000,
        revealScope: 'PENALTY',
      },
    });
    assert.ok(typeof refreshDelay === 'number' && refreshDelay >= 1_000 && refreshDelay <= 10_000);

    // No active reveal or periodic schedule -> null
    const idleDelay = resolveNextAutoExposeTickDelayMs({
      now,
      gameConfig: {
        gameStatus: 'DAY1_ACTIVE',
        startTime: undefined,
        periodicRevealIntervalMinutes: undefined,
        periodicRevealDurationMinutes: undefined,
        locationRevealUntil: undefined,
        teamARevealUntil: undefined,
        teamBRevealUntil: undefined,
      },
      currentUser: {
        team: 'A',
        penaltyRevealUntil: now - 1_000,
      },
      existingExposed: null,
    });
    assert.equal(idleDelay, null);
  });

  test('AdminAuthGate enforces disabled/double-submit guard on submit', () => {
    const authGateSource = fs.readFileSync(path.resolve('views/admin/AdminAuthGate.tsx'), 'utf8');
    assert.match(authGateSource, /const \[isSubmitting, setIsSubmitting\] = useState\(false\)/);
    assert.match(authGateSource, /if \(isSubmitting\) return;/);
    assert.match(authGateSource, /disabled=\{isSubmitting\}/);
  });

  test('Frontend hooks, PWA update, CSS selector, MapView controls, and localized timers satisfy Phase 3 invariants', () => {
    const indexTsx = fs.readFileSync(path.resolve('index.tsx'), 'utf8');
    assert.match(indexTsx, /<ErrorBoundary scope="app">/);
    assert.match(indexTsx, /onNeedRefresh\(\)/);
    assert.match(indexTsx, /vite:preloadError/);

    const appTsx = fs.readFileSync(path.resolve('App.tsx'), 'utf8');
    assert.match(appTsx, /<ErrorBoundary scope="route" resetKey=\{location\.pathname\}>/);
    assert.match(appTsx, /pt-\[max\(0\.375rem,env\(safe-area-inset-top\)\)\]/);
    assert.doesNotMatch(appTsx, /handleUpdateLocation/);
    assert.doesNotMatch(appTsx, /onExposeLocation/);
    assert.match(appTsx, /残り時間が延長されます/);

    const css = fs.readFileSync(path.resolve('index.css'), 'utf8');
    assert.match(css, /\.leaflet-popup-content b\[style\*="color:red"\],\s*\.leaflet-popup-content b\[style\*="color: red"\]/);

    const useAuthUserSource = fs.readFileSync(path.resolve('src/hooks/useAuthUser.ts'), 'utf8');
    assert.match(useAuthUserSource, /prevAuthUserIdRef/);

    const useConfirmDialogSource = fs.readFileSync(path.resolve('src/hooks/useConfirmDialog.ts'), 'utf8');
    assert.match(useConfirmDialogSource, /resolverRef\.current\(false\)/);

    const useMapTimersSource = fs.readFileSync(path.resolve('src/hooks/useMapTimers.ts'), 'utf8');
    assert.match(useMapTimersSource, /isSameMapTimeLeft/);
    assert.match(useMapTimersSource, /prevEpoch5s === nextEpoch5s/);

    const useAdminDashboardSource = fs.readFileSync(path.resolve('views/admin/useAdminDashboard.ts'), 'utf8');
    assert.doesNotMatch(useAdminDashboardSource, /setInterval\(/);

    const emergencyMapSource = fs.readFileSync(path.resolve('views/EmergencyProjectionMap.tsx'), 'utf8');
    assert.match(emergencyMapSource, /EmergencyProjectionList/);
    assert.match(emergencyMapSource, /ResizeObserver/);

    const mapViewSource = fs.readFileSync(path.resolve('views/MapView.tsx'), 'utf8');
    assert.match(mapViewSource, /loadStations/);
    assert.match(mapViewSource, /analyzeTransitSuggestions/);
    assert.match(mapViewSource, /hasInitialCenteredRef/);
    assert.match(mapViewSource, /ResizeObserver/);
    assert.match(mapViewSource, /現在地へ戻る/);
  });
});
