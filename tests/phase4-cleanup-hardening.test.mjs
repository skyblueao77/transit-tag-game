import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { INITIAL_GAME_CONFIG, MISSIONS } from '../constants.ts';
import { closeViteSsrServer, renderSsrComponent } from './helpers/viteSsrLoader.mjs';

after(async () => {
  await closeViteSsrServer();
});

const repoFile = relPath => new URL(`../${relPath}`, import.meta.url);

describe('Phase 4: Spark Single-Backend Cleanup, CI/Test Reliability & Gateway Hardening', () => {
  test('legacy Cloud Functions and Tailwind v3/PostCSS/Studio files are removed', () => {
    for (const removedPath of [
      'functions',
      'functions/package.json',
      'postcss.config.js',
      'tailwind.config.js',
      'metadata.json',
    ]) {
      assert.equal(existsSync(repoFile(removedPath)), false, `${removedPath} must remain deleted`);
    }
  });

  test('package.json, .nvmrc, tsconfig.json, biome.json, and dependabot.yml are cleanly configured', () => {
    const pkg = JSON.parse(readFileSync(repoFile('package.json'), 'utf8'));
    assert.equal(pkg.engines?.node, '>=22.0.0');
    assert.equal(pkg.scripts?.['test:functions'], undefined);
    assert.equal(pkg.scripts?.['test:bundle'], 'node --test tests/production-bundle.test.mjs');
    assert.ok(pkg.dependencies?.firebase, 'firebase must be classified in dependencies');
    assert.ok(pkg.dependencies?.['lucide-react'], 'lucide-react must be classified in dependencies');
    assert.equal(pkg.devDependencies?.firebase, undefined, 'firebase must not be in devDependencies');
    assert.equal(pkg.devDependencies?.['lucide-react'], undefined, 'lucide-react must not be in devDependencies');
    assert.equal(pkg.dependencies?.['@types/leaflet'], undefined);
    assert.ok(pkg.devDependencies?.['@types/leaflet']);
    assert.equal(pkg.overrides?.deepmerge, undefined, 'stale deepmerge override must be removed');
    assert.match(pkg.overrides?.['@grpc/grpc-js'] ?? '', /^\^/);
    for (const legacyDep of ['autoprefixer', 'postcss', '@tailwindcss/postcss']) {
      assert.equal(pkg.devDependencies?.[legacyDep], undefined, `${legacyDep} must be removed`);
    }

    assert.equal(readFileSync(repoFile('.nvmrc'), 'utf8').trim(), '22');
    assert.equal(existsSync(repoFile('.github/dependabot.yml')), true);
    const dependabotYml = readFileSync(repoFile('.github/dependabot.yml'), 'utf8');
    assert.match(dependabotYml, /cooldown:/);
    assert.match(dependabotYml, /groups:/);
    const githubActionsSection = dependabotYml.split(/- package-ecosystem:\s*"github-actions"/)[1] ?? '';
    assert.ok(githubActionsSection.length > 0, 'github-actions ecosystem must be configured');
    const actionsLines = githubActionsSection.split(/\r?\n/);
    const cooldownStartIdx = actionsLines.findIndex(line => /^\s*cooldown:\s*$/.test(line));
    assert.notEqual(cooldownStartIdx, -1, 'github-actions cooldown block must exist');
    const cooldownIndent = actionsLines[cooldownStartIdx].match(/^(\s*)/)?.[1].length ?? 0;
    const cooldownLines = [];
    for (let i = cooldownStartIdx + 1; i < actionsLines.length; i += 1) {
      const line = actionsLines[i];
      if (!line.trim()) continue;
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= cooldownIndent) break;
      cooldownLines.push(line);
    }
    const actionsCooldownBlock = cooldownLines.join('\n');
    assert.match(actionsCooldownBlock, /^\s*default-days:\s*[1-9]\d*\s*$/m);
    assert.doesNotMatch(actionsCooldownBlock, /semver-(?:major|minor|patch)-days\s*:/);

    const tsconfig = JSON.parse(readFileSync(repoFile('tsconfig.json'), 'utf8'));
    assert.equal(tsconfig.compilerOptions?.noUnusedLocals, true);
    assert.equal(tsconfig.compilerOptions?.noUnusedParameters, true);
    assert.equal(tsconfig.compilerOptions?.forceConsistentCasingInFileNames, true);
    assert.equal(tsconfig.exclude, undefined);

    const ciWorkflow = readFileSync(repoFile('.github/workflows/ci.yml'), 'utf8');
    const releaseWorkflow = readFileSync(repoFile('.github/workflows/release.yml'), 'utf8');
    const securityAuditPath = '.github/workflows/security-audit.yml';
    assert.equal(existsSync(repoFile(securityAuditPath)), true);
    const securityAuditWorkflow = readFileSync(repoFile(securityAuditPath), 'utf8');

    assert.doesNotMatch(ciWorkflow, /--prefix functions/);
    assert.doesNotMatch(releaseWorkflow, /--prefix functions/);
    assert.match(ciWorkflow, /npm run test:bundle/);
    assert.match(releaseWorkflow, /npm run test:bundle/);
    assert.match(ciWorkflow, /persist-credentials:\s*false/);
    assert.match(ciWorkflow, /actions\/dependency-review-action@/);
    assert.match(ciWorkflow, /npm audit --audit-level=moderate/);
    assert.match(releaseWorkflow, /persist-credentials:\s*false/);
    assert.match(releaseWorkflow, /npm audit --audit-level=moderate/);
    assert.match(securityAuditWorkflow, /schedule:/);
    assert.match(securityAuditWorkflow, /persist-credentials:\s*false/);
    assert.match(securityAuditWorkflow, /npm audit --omit=dev/);
    assert.match(securityAuditWorkflow, /npm audit --audit-level=moderate/);
  });

  test('Supabase PoC SQL poc_join_session trims whitespace consistently with poc_create_session', () => {
    const sql = readFileSync(repoFile('supabase/migrations/20261016131045_create_poc_foundation.sql'), 'utf8');
    const joinSectionMatch = sql.match(/create or replace function public\.poc_join_session[\s\S]*?AS \$function\$[\s\S]*?\$function\$/i);
    assert.ok(joinSectionMatch, 'poc_join_session definition must exist');
    const matches = joinSectionMatch[0].match(/pg_catalog\.btrim\([^,]+,\s*E' \\t\\n\\r'\)/g);
    assert.equal(matches?.length, 2, 'poc_join_session must trim join code and player name using E\' \\t\\n\\r\'');
  });

  test('verify-100-patterns.mjs removes hardcoded paths and executes real verification suites', () => {
    const script = readFileSync(repoFile('scripts/verify-100-patterns.mjs'), 'utf8');
    assert.doesNotMatch(script, /\/home\/antigravity\/jdk21/);
    assert.doesNotMatch(script, /PASS \(Rules Emulated\)/);
    assert.match(script, /--write-report/);
    assert.match(script, /process\.exitCode = 1/);
  });

  test('gateways keep receipt/completion reads and server clock reads inside runTransaction and enforce batch bounds', () => {
    const opsGateway = readFileSync(repoFile('src/infrastructure/firebase/gateways/adminOperationsGateways.ts'), 'utf8');
    const sessionGateway = readFileSync(repoFile('src/infrastructure/firebase/gateways/adminSessionGateways.ts'), 'utf8');
    const gameplayGateway = readFileSync(repoFile('src/infrastructure/firebase/gateways/gameplayGateways.ts'), 'utf8');

    assert.doesNotMatch(opsGateway, /await getDoc\(receiptRef\)/);
    assert.match(opsGateway, /transaction\.get\(receiptRef\)/);

    assert.doesNotMatch(gameplayGateway, /await getDoc\(/);
    assert.match(gameplayGateway, /transaction\.get\(completionRef\)/);

    // In adminSessionGateways.ts, only writeBatch-based executeGameReset may read receiptRef outside runTransaction.
    const sessionReceiptGetDocs = sessionGateway.match(/await getDoc\(receiptRef\)/g) ?? [];
    assert.equal(sessionReceiptGetDocs.length, 1, 'only executeGameReset (writeBatch) may call await getDoc(receiptRef)');
    assert.match(sessionGateway, /transaction\.get\(receiptRef\)/);

    assert.match(opsGateway, /pendingUpserts\.length > 495|participantIds\.length > 495/);
    assert.match(sessionGateway, /participantIds\.length > 495/);
    assert.match(gameplayGateway, /participantIds\.length > 495/);
  });

  test('AdminMissionCenter CATALOG tab renders JSON Export/Import buttons when handlers are supplied', async () => {
    const baseProps = {
      config: { ...INITIAL_GAME_CONFIG, gameSessionId: 'session-p4', gameStatus: 'PRE_GAME' },
      allMissionsList: MISSIONS,
      filteredMissions: MISSIONS.slice(0, 2),
      liveCompletions: [],
      missionTab: 'CATALOG',
      onChangeTab: () => {},
      missionSearch: '',
      onChangeSearch: () => {},
      manualMissionId: '',
      onChangeManualMissionId: () => {},
      manualAwardTeam: 'A',
      onChangeManualAwardTeam: () => {},
      manualAwardMissionId: '',
      onChangeManualAwardMissionId: () => {},
      isProcessing: false,
      onCreateMission: () => {},
      onEditMission: () => {},
      onDeleteMission: () => {},
      onToggleMissionMode: () => {},
      onManualAssign: () => {},
      onShuffleMissions: () => {},
      onSyncMissionCatalog: () => {},
      onAdminAwardMission: () => {},
    };

    const withExportImport = await renderSsrComponent('/views/admin/AdminMissionCenter.tsx', {
      ...baseProps,
      onExportMissions: () => {},
      onImportMissions: async () => {},
    });
    assert.match(withExportImport, /JSONエクスポート/);
    assert.match(withExportImport, /JSONインポート/);

    const withoutExportImport = await renderSsrComponent('/views/admin/AdminMissionCenter.tsx', baseProps);
    assert.doesNotMatch(withoutExportImport, /JSONエクスポート/);
  });
});
