# Release Readiness Record

検証日: 2026-10-15
検証対象: `main` / `9b16f3e1ceb4175446683a87744d6c6434685620`
本書はローカル検証記録です。Production release approvalやdeploy記録ではありません。

## 結果

**Automated release hardening: CONDITIONAL PASS — Node 22 Root / Functions / Rules、isolated Projection stability、Safety stress、Continuous E2E、Full Integrationが今回PASS**

**Production rollout: NO-GO — staging Trigger latency/smoke、browser offline/reconnect、response-loss replay、rollback rehearsalが未実施**

以前のstrict 5秒Integration poll failureは、validなTriggerがProjectionを最終commitする前にEmulatorのdispatch/worker schedulingが遅れた事象です。Firestore background Triggerに厳密な5秒完了保証はなく、5秒をProduction correctness contractとはしません。IntegrationはLocation commitとSession/schema/freshnessを確認し、Emulator harness上限内のeventual Projectionと厳密なProjection内容を検証します。

Node 22のfresh Emulator dedicated Projection testは20/20 Player・80/80 Location writes・20/20 cleanupでPASS。Safety suiteはclear-between-runs 10/10と同一Emulator/no-clear 10/10、Continuous E2Eは3/3、通常のFull Functions Integrationは12/12 suiteでPASS。Production source、Rules、依存関係、lockfilesは変更していません。Production deploy、commit、pushは未実施です。

Emergency Projectionは運営向けのlocation-sharing aidであり、即時deliveryやemergency serviceへの通知を保証しません。Emulatorのlatency値をProduction性能値へ外挿しません。

## 検証環境

- OS: Windows
- Current continuation platform: Windows
- Root/default Node.js: `v24.20.0`; npm: `12.2.0`
- This continuation's validation Node.js: `v22.23.3`（fnm）、npm CLI: `10.9.9`
- Java: `25.0.4.1`
- Firebase CLI: `15.32.1`（project-local）
- Emulator project: `demo-no-project`のみ
- Functions targetは`nodejs22`。今回のFunctions build / Integration / Safety調査ではNode 22 installationを`PATH`先頭へ明示し、Emulator host / Functions workerともNode 22であることを確認した。

## Clean install / 再現性

- 初回PR #34監査前の`main` working treeはclean、HEADは上記commit。今回の継続開始時には`functions/package.json`変更、2つの未追跡Integration test、既存の未追跡`RELEASE_READINESS.md`があった。
- Rootと`functions/`の`npm ci`が完了し、両lockfileに差分なし。
- Windowsの`cmd.exe` spawnが`EACCES`となるため、最初の`npm ci`は失敗。install回避のためにpackage scriptやlockfileは変更せず、1回限りの`--script-shell`指定で両installを完了した。後続の`functions/package.json`変更はIntegration suite追加・順序調整のみ。
- Install後およびbuild後にtracked source/lockfile差分はなかった。生成された`dist/`と`functions/lib/`はbuild artifactであり、tracked変更ではない。

## Automated validation

| Check | Result |
| --- | --- |
| Root typecheck | PASS — Node 22.23.3 |
| Root tests | PASS — 193 tests / 36 suites, Node 22.23.3 |
| Root build | PASS — 841.42 kB minified JS; Viteの500 kB chunk warningあり |
| Functions build | PASS — Node 22.23.3 |
| Functions Service tests | PASS — 131 tests / 13 suites, Node 22.23.3 |
| Firestore Rules tests | PASS — 29 tests, direct Emulator + `node --test`, Node 22 |
| Full sequential Functions Integration | PASS — 12/12 suite processes, Node 22.23.3, single fresh Emulator process |
| Continuous release flow | PASS — 3/3, same dataset per run; Reset後Location再登録・同一Mission再完了まで |
| Dedicated Emergency Projection stability | PASS — fresh Emulator、20/20 unique Players、80/80 committed Location writesとcurrent-Session Projection、20/20 ACTIVE cleanup |
| Safety stress, clear between runs | PASS — 10/10 runs × 10 tests、socket hang up 0、timeout 0 |
| Safety stress, same Emulator/no clear | PASS — 10/10 runs × 10 tests、suiteごとに新Auth UID、socket hang up 0、timeout 0 |
| Reset vs Setup integration | PASS — 5 iterations、accepted=3、denied=2、preview refresh=3 |
| Root production dependency audit | PASS — 0 vulnerabilities (`npm audit --omit=dev`) |
| Functions production dependency audit | PASS — 0 vulnerabilities (`npm --prefix functions audit --omit=dev`) |
| Lockfiles | Unchanged |

Node 22.23.3 / npm 10.9.9 / Firebase CLI 15.32.1で検証。Functions Emulator workerはNode 22 PATHを明示して起動。Dedicated Projection testの30秒上限はEmulator suite hang guardであり、Production SLOではない。

`npm run test:rules`はWindows `cmd.exe` spawnの`EACCES`回避のため、Emulatorを起動して`node --test tests/firestore-rules.test.mjs`を直接実行し、今回29件PASS。Functions Integration 12 suitesは1つのNode 22 Emulator process上で順次実行した。Dedicated Projection stability testは高負荷suiteのTrigger backlogを持ち越さないよう、通常Integration commandから分離し、fresh Emulatorで個別に実行する。

Node 22の通常Full Integrationは既存suiteにContinuous E2E、Reset/Setup競合を含め12/12 suite process PASS。Dedicated Projection stabilityはfresh Emulatorで個別実行した。高負荷Full Integrationの直後に同じEmulator上で専用Projection testを追加実行した試行では、Player/Config/Location Session一致・EMERGENCY state・Location commit/readback後、30秒のEmulator harness上限内にProjectionを観測できず失敗した。この順序はdedicated fresh-Emulator acceptance runとは分離し、Trigger backlogが次suiteへ残るlocal Emulatorの制約として記録する。これはProduction 5秒SLOの失敗とは解釈しない。

## Safety / Projection trigger stability

### Failure evidence and classification

- Historical strict-poll failure: `Emergency without fresh location still succeeds; private location create/update triggers projection refresh`でProjectionをpoll boundary内に観測できなかった。同一座標heartbeat testとは別case。初回Emergency request時にはLocationがなく、その後のAuth付きprivate-location REST `PATCH`がcommitした。現在は「commit後にEmulator harness上限までeventually確認」として試験し、5秒完了をassertしない。
- Historical failing UID `ulpxhvkp29bC2UMyNKUMYK4MWyol`のsnapshotはConfig / Player / LocationすべてSession `123e4567-e89b-42d3-a456-426614174000`、schema 2、Player `EMERGENCY`、Team A、Location `updatedAt=1792021373644`、Projectionなし。Auth付きREST `PATCH`のFirestore commitは`2026-10-14T23:42:54.751311Z`。座標はtest fixtureの36.1/140.1。当時の5秒poll開始は`1792021374767`、終了は`1792021379770`（5,003ms、最後のin-flight readでdeadlineを3ms超過）。旧50回sleep方式では別runで6,592msを要した。現在のIntegration contractはこの5秒境界を使用しない。
- Safety failureのtraceでは、初回Emergency Callable内のProjection readはLocation/Projectionなしを正しく読みwrite 0。後続`reconcileEmergencyProjectionAfterPlayerWrite`は`1792021380521`（23:43:00.521Z、poll終了751ms後）に始まり、正しいConfig/Player/Location/Session/freshnessを読みProjectionをset、`1792021380586`（23:43:00.586Z、poll終了816ms後）にcommitした。2回目のPlayer triggerは`1792021380605`、`onPrivateLocationWritten`は`1792021380725`（poll終了955ms後）に開始し、両者は既存Projectionを再読してset/commit。各transactionは1 attempt、deleteなし。
- Historical dedicated test failureでも別UIDで同じdispatch遅延があった。poll windowは`1792020803620–1792020810420`、`reconcileEmergencyProjectionAfterPlayerWrite` transactionは`1792020809226`に開始、`1792020810486`にcommit（当時のpoll終了66ms後）。Location write responseとread-backのSession/timestampは一致。現在のfresh-Emulator dedicated testは後述のとおり20/20で完了。
- **Failure classification: Trigger dispatch / worker scheduling latency, not Projection logic rejection.** Historical Node 22 Emulator traceではlocation commitの約5.77秒後に最初のProjection transactionが開始し、その約816ms後にcommitした。Transaction到達後のConfig Session、Player status、Location Session/freshness/coordinate validationとwriteは成功し、Session mismatch、early return、timestamp rejection、transaction failure、competing deleteはなかった。Firestore background Triggerに5秒完了保証がないため、この遅延をProduction correctness failureとは扱わない。Emulatorの結果からProduction latencyを推定することもしない。
- Emulator専用trace preloadはTrigger event ID/document/UID/start-end、transaction read/writeを記録する。緯度経度、Player name、token、credentialは出力しない。Trigger event、Location timestamp、Projection document updateTimeをUID単位で相関した。Functions worker runtimeは`node@22`。
- Service/CoreのProjection writeを行わない分岐は、Config欠落/Session schema不正、Player欠落またはid/name/team/status/Session不正、statusがEMERGENCY以外、Location欠落/id/Session不一致、updatedAt欠落・不正・future、座標不正、freshness期限切れ。Transaction read/commit例外はTriggerへ伝播しretry対象。今回の失敗traceはそれらの早期returnを通っていない。

### Confirmed

- Projection Service/Coreがcurrent Sessionの`EMERGENCY` Playerとvalid/fresh Locationに対して厳密なschemaのProjectionを作成し、malformed / stale / old Session inputを拒否することをUnit/Service/Integrationで確認。Node 22 Service testsにはPlayerとLocation双方のold Session mismatch・write 0件の回帰caseを追加し、131/131 PASS。
- Config / Player / Location Session一致、source timestamp、active expiryとAdmin-only read/client-write denialを確認。Cross-player privacy boundaryとClient Projection write denialはRules 29/29でPASS。両Firestore Triggerはevent snapshotではなくcurrent Config/Player/Locationをtransaction内で再読する。
- Node 22 fresh Emulatorでcommit後のeventual Projection creationとACTIVE cleanupを80/80 heartbeat、20/20 Playerで確認。

### Not guaranteed / operational limitation

- Five-second Projection completion、immediate Firestore Trigger dispatch、Production latencyは保証・検証していない。30秒はEmulator test harnessのhang guardのみ。
- 80/80 stress writesでstale eventによるcurrent Projection削除は観測しなかった。event payloadに基づくdeleteは行わず、Service transactionはcurrent stateを読む。ただしEmulator上でout-of-order Trigger retryを強制する決定論的試験は実施していない。
- Emergency Projectionは運営向けlocation-sharing aidであり、即時deliveryやemergency serviceへの通知を保証しない。

### Node 22 stability runs and latency

- Dedicated test: fresh Emulator、20 unique Players、80/80 committed same-coordinate heartbeat writesを個別に確認し、80/80 current-Session Projectionと20/20 ACTIVE cleanupがPASS。30秒はEmulator suite hang guardのみ。
- Safety stress: fresh Emulatorで全体clearを挟み10/10 run、同一Emulatorでclearなし10/10 run。各run 10 tests、いずれもsocket hang up 0、timeout 0。
- Continuous E2E: fresh Emulatorを使い3/3 PASS。通常のFull sequential Functions Integrationは別のfresh Emulatorで12/12 suite PASS。これらのrunではProjectionのfinal state欠落なし。
- Dedicated stabilityの80 successful Projectionについて、Firestore Location `updateTime`からProjection document `updateTime`までのEmulator end-to-end latencyはmin 15.054ms、median 81.441ms、p95 207.61ms、max 6,668.997ms。Trigger start/endとLocation commit、Projection commitも80/80をtraceで相関。writerは`users/{uid}`または`privateLocations/{uid}`のbackground Trigger。Trigger startがLocation commitより先行するケースは`users/{uid}` eventがcurrent Locationを読んでProjectionを作るためであり、負のdeltaをlocation dispatch latencyとして解釈しない。Emulator値からProduction性能を外挿しない。
- 同じEmulator上で高負荷Full Integration直後にDedicated testを続けた試行では、最初のLocationはcommit/readback済み、Session一致・EMERGENCYも確認したが、30秒のEmulator harness limitまでにProjectionを読めずtest failureとなった。これはfresh Emulator acceptance runとは別のloaded-Emulator結果であり、queued Triggerのdrainを`clear`が保証するとは扱わない。通常IntegrationとDedicated stabilityは別のfresh Emulator/runとして実行する。
- Trace-enabled Full IntegrationではReset Preview後にProjection revisionが変わり`CONFIRMATION_STALE`でfail-closed拒否されたrunがあった。これはResetのstale confirmation protectionが働いた結果。別Emulator/no-traceのFull Integrationは12/12 PASS、Continuous E2Eは3/3 PASS。Production source/Rules/heartbeat/freshness/privacy/dependencies/lockfilesに変更なし。
- 過去に高roster suite後のReset Projection cleanup assertion、別runのMission Callable JSON parse failureもあった。今回のNode 22 no-trace sequential runでは12/12 suite PASS。高負荷suite後にdedicated Projection stressを同じEmulatorで連結すると30秒harness limitを超えたため、両検証を別Emulator sessionで実行する。`CONFIRMATION_STALE`時はPreviewを更新し、Reset validationを緩めない。Production Trigger latency/retryはstagingで未検証。

## Security / static review

- Client SDKのauthoritative direct writeは検索上、Setupのown `users` + `privateLocations` batch、Owner private-location upsert、Owner individual exposed snapshotに限定。
- Clientからの`game_config`、Mission、Completion、Admin/receipt、Player gameplay-authority write経路は見つからなかった。Admin操作はCallable経由。
- App/Admin intentに`expectedSessionId`があり、Functions側はSession-aware requestを扱う。stale Session拒否はMission、Capture、Invincibility、Waiting、Safety、Role Swap/Resume、Reveal、Phase、Mission Admin、Score、ResetのIntegration/Service coverageで確認。
- Rules testsはAdmin ClientによるConfig/Session/log、Mission、Player authority write、cross-player private location read、old Session Location、Projection/Completion/receipt Client writeの拒否を含む。
- HTML injection sink候補（`innerHTML`等）および一般的な埋め込みsecret/private-key patternはtracked source/config/docsから検出されなかった。Popup表示の既存回帰testもRoot suiteに含まれる。
- Root/Functions buildは成功し、unresolved importは検出されなかった。
- `Master Reset Preview` UIはTrusted Preview/Execute Callableへ接続され、旧ClientのExecute request shape拒否はReset Integrationで確認。Client direct Reset writeは見つからなかった。

## Continuous E2E / Reset・新Session結果

`functions/test/releaseFlow.integration.test.mjs`はsuite開始時のみFirestore/Authをclearし、その後は同じdatasetでSession initialization、A/B Setup、Location、DAY1、Mission、Capture、Waiting、Invincibility、Pause/Resume、Reveal、Safety/Retire、DAY2、Final Mission、Game Over、Reset/replay、stale request、Location再登録、新Sessionでの同じMission再完了を行う。

- Node 22 fresh Emulatorで3回実行: 3/3 PASS。各runは同じ継続dataset内でSession initialization、DAY1/Gameplay/Safety、DAY2/Final、Game Over、Trusted Reset/stable replay、stale request拒否、Reset後Location再登録、同じMissionの新Session再完了まで確認。
- 通常Full sequential IntegrationはNode 22、fresh Emulatorで12/12 suite PASS。Dedicated Projection stressはsuite trigger backlogを混ぜない別fresh Emulatorで実施（詳細はSafety / Projection節）。
- 最初の再現では20%確率のMission Lucky rewardを無視してCapture後のカード数を固定値assertしていた。Completionの`luckyReward`に基づくtest-only期待値へ修正済み。Gameplay/Production codeは変更していない。
- Reset/Setup競合: 独立Emulatorの5 iterationおよびNode 22 full sequential runでPASS。Setup-first時のstale preview更新、Reset後のold Session Setup拒否、新Session Player bindingを確認。Emulatorでtransaction内部の厳密なmid-transaction overlapを強制したものではないため、実ブラウザ同時操作は未検証。

Rules/Functions別suiteではSession isolation、stale request拒否、current Session Location、Projection Admin-only、Completion Session scope等を確認。Repositoryにbrowser E2E runnerはなく、React UIを通した実画面smokeは未実施。

## Manual browser / staging smoke（未実施）

Browser UI full-flow、Player offline/reconnect、Admin response-loss replay、staging project上のdeployed Trigger latency測定はいずれも未実施。Emulator IntegrationのCallable replayは実network response lossを再現するものではない。

## Offline / retry coverage

- Admin Callableを同じ`requestId`で再送するidempotency/replay testあり。
- Resetは同一request replayで同じ結果を返し、二重ResetしないことをIntegrationで確認。
- stale Session request拒否を複数Actionで確認。
- 実際にHTTP応答を破棄する試験、ブラウザoffline/online遷移、Player reconnect後のUI復帰は未実施。Reset/Role Swap/Score replayのCallable idempotencyは確認したが、ネットワーク切断によるresponse lossを再現したものではない。

## Staging smoke checklist（未実施）

Productionではなく、release前のstaging/non-Production projectで専用のSession/ユーザーを使う。Production deployはこのPRでは行わない。

1. Functions Node 22 deploy後、Callable discoveryとSession initializationを確認。
2. 新ClientでTeam A/B Setup、current Session Location、Mission/Gameplay/Admin Callableを確認。
3. Reset Preview/Execute、same requestId replay、Reset後の新Session Location再登録と同じMission再完了を確認。
4. Emergency ProjectionのTrigger start/commit/latencyを実測し、運営上許容できる応答時間と最終作成/cleanupを確認。5秒を前提にしない。
5. Player offline時にheartbeat失敗を成功扱いしないこと、reconnect後にConfig Session再取得・Location再送・UI復旧を確認。
6. Score Adjustment、Role Swap、Resetでcommit後にresponseを失い、same requestId replayが二重実行しないことを確認。
7. Admin direct Config/User/Mission writeがDENYされ、必要なOwner Setup/location writeが許可されることを確認。
8. 旧Clientからdirect Reset/Player delete/Admin state writeが拒否されることを確認。

## Rollout / rollback

PR #33の互換性方針に従い、**Functions → Client → non-Production smoke → initializeGameSession / Location再登録 → Rules → old Client rejection verification**の順にする。RulesをFunctions/Clientより先にdeployしない。Production rolloutは承認まで実施しない。

Repositoryから確認できたdeploy command（いずれも未実行）:

- Functions: `npm --prefix functions run build`、続けて`firebase deploy --only functions --project <approved-project-id>`。`firebase.json`のFunctions predeployもbuildを指定。
- Client/Hosting: `npm run build`、続けて`firebase deploy --only hosting --project <approved-project-id>`。
- Rules: smokeと新Client確認後に`firebase deploy --only firestore:rules --project <approved-project-id>`。
- Production project aliasはrepositoryで確認できない。Production project ID、権限、承認、実際のrollback手順は運用担当者がProduction前に確認する。

- Functions deploy後、new ClientとCallable discoveryを確認。旧Clientを停止/遮断する計画を確認後、新Clientを展開し、Reset等のsmokeを行う。
- legacy ConfigのSession initializationは、Session-aware Functions/Client稼働後にAdminが明示実行する。以降、Player Session bindingとReset後Location再登録を確認してからRulesをdeployする。
- Rules deploy前に問題が起きた場合はrolloutを停止し、Callable契約に互換性のあるFunctions/Clientの組み合わせだけを戻す。
- Rules deploy後は旧Client direct write拒否が意図したSecurity behavior。権限を広げるRules rollbackやdirect write復活で回避しない。必要なRules rollbackはSecurity reviewと承認後のみ。
- HostingはFirebaseの直前releaseへ戻す経路、Functionsは同一targetの直前互換sourceをdeployする経路をProduction前に運用担当者が確認する。成功済みGame Resetは通常のcode rollbackで戻らず、自動rollback対象外。復旧にはbackup/restore判断が必要。
- このrollback手順は机上確認のみで、Emulator/Production実地検証は未実施。

## Known limitations / release gate

- Player deletionおよび一部legacy Admin direct-write操作は提供されない。Rulesを弱めて復旧させない。
- Request receipt TTL cleanupは未実装。
- Root production dependency auditは0件だが、`npm ci`の全依存監査概要にはdev依存を含む11件（moderate 4 / high 7）の警告が表示された。Feature Freeze中のため自動更新はしていない。
- Root bundleは500 kB超warningあり。build自体は成功。
- Projectionに厳密な5秒完了保証はない。Integrationの30秒上限はEmulator harness hang guardであり、Production SLOではない。
- High-load suite後、same-Emulatorで続けたdedicated stress invocationが30秒harness limitを超えた記録あり。Fresh-Emulator専用stability acceptanceは20/20でPASS。Trigger backlogがqueued eventのdrainをclearで保証しないため、二つの検証を同じEmulator sessionに混在させない。
- Trace-instrumented Reset Previewが`CONFIRMATION_STALE`となったケースはfail-closed behavior。運営者はPreviewを更新してからResetを再確認する必要があり、staging UI smokeで操作性を確認する。
- Browser offline/reconnect、実HTTP response-loss、staging Trigger latency/smoke、rollback rehearsalは未実施。Emergency Projectionは運営向けlocation-sharing aidであり、即時deliveryやemergency serviceへの通知を保証しない。

**Automated release hardening: CONDITIONAL PASS. Production rollout: NO-GO.** General release前にstaging project smokeと実deployed Trigger latency測定、browser offline/reconnect、response-loss replay、rollback rehearsalを完了する。
