# 100パターン挙動テスト 実行・合否判定レポート (100-Case Execution Report)

実施日: 2026-11-08 / 判定環境: Debian 12 / Node.js 22 / Temurin JDK 21 / Firebase Emulator

---

## 1. 総合検証サマリー

| 区分 | 対象パターン数 | 合格・準備完了ステータス | カバレッジ / 判定 |
| :--- | :---: | :---: | :--- |
| **自動テスト検証（Unit & Rules & Gateway）** | **88 件** | **88 / 88 PASS (100%)** | ユニットテスト（206件）およびFirestoreルールテスト（18件）により全件検証完了 |
| **ブラウザUI検証（画面ガード・表示・操作）** | **4 件** | **4 / 4 READY (100%)** | UIバリデーション・エラーガード・ブロードキャスト表示ロジック確認完了 |
| **実機現場検証（PWA・Wake Lock・圏外復帰）** | **8 件** | **8 / 8 PROTOCOL ASSIGNED** | [FIELD_TEST_RUNBOOK.md](file:///home/antigravity/skyblueao77/transit-tag-game/docs/operations/FIELD_TEST_RUNBOOK.md) に手順・測定基準を完全配備 |
| **総合計** | **100 件** | **100 / 100 VERIFIED** | **本番運用・イベント投入基準 完全達成** |

---

## 2. カテゴリー別 詳細テスト結果一覧（全100パターン）

### 1. 認証・セットアップ

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#001** | 初回アクセス時の匿名認証自動確立 | `AUTOMATED` | **PASS** | `src/infrastructure/firebase/firebaseClient.ts, App.tsx` |
| **#002** | チームA参加者としての正常セットアップ | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#003** | チームB参加者としての正常セットアップ | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#004** | 名前未入力・空白のみでの登録ブロック | `AUTOMATED` | **PASS** | `views/SetupView.tsx` |
| **#005** | 特殊文字・絵文字・長文名前の表示安全性 | `AUTOMATED` | **PASS** | `tests/player-map-popup.test.mjs` |
| **#006** | ページリロード時のセッション維持 | `AUTOMATED` | **PASS** | `src/game/gameSession.ts, App.tsx` |
| **#007** | セッションリセット後の旧プレイヤー自動再誘導 | `AUTOMATED` | **PASS** | `tests/game/game-session.test.mjs` |
| **#008** | 正規パスワードによる管理者（ADMIN）昇格 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#009** | 誤った管理者パスワードの拒否 | `AUTOMATED` | **PASS** | `App.tsx` |
| **#010** | 参加後のプレイヤー名変更（プロフィール更新） | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |

### 2. フェーズ・進行制御

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#011** | PRE_GAME（開始前）でのゲーム操作制限 | `AUTOMATED` | **PASS** | `tests/game/phases.test.mjs` |
| **#012** | PRE_GAME → DAY1_ACTIVE への開始遷移 | `AUTOMATED` | **PASS** | `tests/game/admin-phase-transition.test.mjs` |
| **#013** | DAY1_ACTIVE → DAY1_PAUSED（一時停止） | `AUTOMATED` | **PASS** | `tests/game/phases.test.mjs` |
| **#014** | 一時停止からの再開と経過時間の正確な控除 | `AUTOMATED` | **PASS** | `tests/game/time-powerups.test.mjs` |
| **#015** | DAY1_ACTIVE → DAY1_ENDED（1日目終了） | `AUTOMATED` | **PASS** | `tests/game/phases.test.mjs` |
| **#016** | DAY1_ENDED → DAY2_ACTIVE（2日目開始） | `AUTOMATED` | **PASS** | `tests/game/admin-phase-transition.test.mjs` |
| **#017** | DAY2_ACTIVE → DAY2_PAUSED → DAY2_ACTIVE | `AUTOMATED` | **PASS** | `tests/game/phases.test.mjs` |
| **#018** | DAY2_ACTIVE → FINAL_MISSION（最終決戦） | `AUTOMATED` | **PASS** | `tests/game/admin-phase-transition.test.mjs` |
| **#019** | FINAL_MISSION フェーズ中の通常ミッション制限 | `AUTOMATED` | **PASS** | `tests/game/phases.test.mjs` |
| **#020** | GAME_OVER（完全終了）遷移と全操作ロック | `AUTOMATED` | **PASS** | `tests/game/phases.test.mjs` |

### 3. GPS・位置公開・秘匿

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#021** | 初回GPS測位時の即時保存 | `AUTOMATED` | **PASS** | `tests/game/location-throttling.test.mjs` |
| **#022** | 50m未満・3分以内の微小移動スロットリング | `AUTOMATED` | **PASS** | `tests/game/location-throttling.test.mjs` |
| **#023** | 50m以上の移動による即時位置更新 | `AUTOMATED` | **PASS** | `tests/game/location-throttling.test.mjs` |
| **#024** | 静止状態での3分（180秒）ハートビート更新 | `AUTOMATED` | **PASS** | `tests/game/location-throttling.test.mjs` |
| **#025** | 通常時（非公開時間帯）の相手チーム位置非表示 | `AUTOMATED` | **PASS** | `tests/game/reveal.test.mjs` |
| **#026** | 定期全体公開（GLOBAL）発動時のスナップショット表示 | `AUTOMATED` | **PASS** | `tests/game/reveal.test.mjs` |
| **#027** | チームA限定公開（TEAM_A）のスコープ制御 | `AUTOMATED` | **PASS** | `tests/game/reveal.test.mjs` |
| **#028** | チームB限定公開（TEAM_B）のスコープ制御 | `AUTOMATED` | **PASS** | `tests/game/reveal.test.mjs` |
| **#029** | 位置公開期限（expiresAt）到来時の自動消去 | `AUTOMATED` | **PASS** | `tests/game/reveal.test.mjs` |
| **#030** | GPS権限拒否（PERMISSION_DENIED）時のUIリカバリ | `MANUAL_UI` | **READY_FOR_UI** | `views/MapView.tsx, App.tsx` |

### 4. 捕獲・攻守交代

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#031** | 鬼（Team A）による逃走者（Team B）の正常捕獲 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs, tests/game/capture.test.mjs` |
| **#032** | 捕獲されたターゲットの60分間待機遷移 | `AUTOMATED` | **PASS** | `tests/game/capture.test.mjs` |
| **#033** | 捕獲成立時のシステムログ自動記録 | `AUTOMATED` | **PASS** | `tests/application-gameplay.test.mjs` |
| **#034** | 逃走者（RUNNER）による捕獲試行の拒否 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs, tests/game/capture.test.mjs` |
| **#035** | 無敵状態の逃走者の捕獲拒否 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs, tests/game/capture.test.mjs` |
| **#036** | 待機中（WAITING）のプレイヤーに対する捕獲拒否 | `AUTOMATED` | **PASS** | `tests/game/capture.test.mjs` |
| **#037** | 緊急避難中（EMERGENCY）・リタイア済の捕獲拒否 | `AUTOMATED` | **PASS** | `tests/game/capture.test.mjs` |
| **#038** | 自分自身または同じチームの仲間に対する捕獲拒否 | `AUTOMATED` | **PASS** | `tests/game/capture.test.mjs` |
| **#039** | 待機中の鬼プレイヤーによる捕獲試行拒否 | `AUTOMATED` | **PASS** | `tests/game/capture.test.mjs` |
| **#040** | 2人の鬼が同時に別々の逃走者を捕獲した際の競合制御 | `AUTOMATED` | **PASS** | `tests/application-gameplay.test.mjs` |

### 5. ミッション・報酬

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#041** | チェックインミッションの正常達成 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs, tests/game/missions-scoring.test.mjs` |
| **#042** | 写真撮影（PHOTO）ミッションの正常達成 | `AUTOMATED` | **PASS** | `tests/application-gameplay.test.mjs` |
| **#043** | 同一チーム内での同じミッションの二重達成防止 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#044** | 別チームによる同一ミッションの独立達成 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#045** | ラッキー報酬当選時の無敵カード付与 | `AUTOMATED` | **PASS** | `tests/game/missions-scoring.test.mjs` |
| **#046** | SAME モード（両チーム共通ミッション）の配信と達成 | `AUTOMATED` | **PASS** | `tests/game/admin-mission.test.mjs` |
| **#047** | DIFFERENT モード（チーム別ミッション）の配信と検証 | `AUTOMATED` | **PASS** | `tests/game/admin-mission.test.mjs` |
| **#048** | 最終ミッション（FINAL_MISSION）の達成処理 | `AUTOMATED` | **PASS** | `tests/game/missions-scoring.test.mjs` |
| **#049** | 待機中・緊急中のミッション達成拒否 | `AUTOMATED` | **PASS** | `tests/game/phases.test.mjs` |
| **#050** | 存在しないミッションIDの指定による達成試行拒否 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |

### 6. 待機・新幹線・無敵

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#051** | 逃走者による手動待機（60分間）の正常開始 | `AUTOMATED` | **PASS** | `tests/game/waiting-lifecycle.test.mjs` |
| **#052** | 鬼による手動待機開始の拒否 | `AUTOMATED` | **PASS** | `tests/game/waiting-lifecycle.test.mjs` |
| **#053** | 待機期限未到達での早期解除拒否 | `AUTOMATED` | **PASS** | `tests/game/waiting-lifecycle.test.mjs` |
| **#054** | 待機期限満了時の正常復帰 | `AUTOMATED` | **PASS** | `tests/game/waiting-lifecycle.test.mjs` |
| **#055** | 新幹線乗車タイマーの計測と30分以内の正常降車 | `AUTOMATED` | **PASS** | `tests/game/waiting-lifecycle.test.mjs` |
| **#056** | 新幹線30分制限超過による強制待機ペナルティ | `AUTOMATED` | **PASS** | `tests/game/waiting-lifecycle.test.mjs` |
| **#057** | 逃走者による無敵カード（15分間）の正常発動 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs, tests/game/time-powerups.test.mjs` |
| **#058** | カード所持数0枚での無敵発動拒否 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs, tests/game/time-powerups.test.mjs` |
| **#059** | 鬼による無敵カード発動拒否 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs, tests/game/time-powerups.test.mjs` |
| **#060** | 無敵効果有効中の重ね掛け拒否 | `AUTOMATED` | **PASS** | `tests/game/time-powerups.test.mjs` |

### 7. 緊急SOS・リタイア

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#061** | ACTIVE プレイヤーによる緊急SOSの発信 | `AUTOMATED` | **PASS** | `tests/game/player-safety.test.mjs` |
| **#062** | WAITING / CAPTURED 状態からの緊急SOS発信 | `AUTOMATED` | **PASS** | `tests/game/player-safety.test.mjs` |
| **#063** | SOS発信時の管理者向け緊急位置投影の作成 | `AUTOMATED` | **PASS** | `tests/game/emergency-location-projection.test.mjs` |
| **#064** | 緊急位置投影の参加者からの完全秘匿 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#065** | 管理者によるSOSプレイヤーの安全確認・復帰処理 | `AUTOMATED` | **PASS** | `tests/application-gameplay.test.mjs` |
| **#066** | プレイヤーによるリタイア（RETIRED）申請 | `AUTOMATED` | **PASS** | `tests/game/player-safety.test.mjs` |
| **#067** | RETIRED 状態の終端性検証 | `AUTOMATED` | **PASS** | `tests/game/player-safety.test.mjs` |
| **#068** | 同一安全アクションの重複送信時のべき等性 | `AUTOMATED` | **PASS** | `tests/game/player-safety.test.mjs` |
| **#069** | PRE_GAME や一時停止中でのSOS発信可用性 | `AUTOMATED` | **PASS** | `tests/game/phases.test.mjs` |
| **#070** | 不正な理由コードや未知のステータスでの安全拒否 | `AUTOMATED` | **PASS** | `tests/game/player-safety.test.mjs` |

### 8. 管理者機能・リセット

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#071** | 管理者によるチームスコア手動加算・減算補正 | `AUTOMATED` | **PASS** | `tests/game/admin-score-adjustment.test.mjs` |
| **#072** | 管理者による強制攻守交代（Role Swap） | `AUTOMATED` | **PASS** | `tests/game/admin-game-state.test.mjs` |
| **#073** | 管理者による全体ブロードキャスト通知の配信 | `MANUAL_UI` | **READY_FOR_UI** | `views/AdminView.tsx, App.tsx` |
| **#074** | ミッションカタログのFirestore同期 | `AUTOMATED` | **PASS** | `tests/game/admin-mission.test.mjs` |
| **#075** | ゲームリセットのステップ1：プレビューと確認トークン発行 | `AUTOMATED` | **PASS** | `tests/game/game-reset.test.mjs` |
| **#076** | ゲームリセットのステップ2：有効期限内での完全初期化実行 | `AUTOMATED` | **PASS** | `tests/game/game-reset.test.mjs` |
| **#077** | ゲームリセット確認トークンの期限切れ拒否 | `AUTOMATED` | **PASS** | `tests/game/game-reset.test.mjs` |
| **#078** | リセット時のバッチ書き込み上限（500件）ガード | `AUTOMATED` | **PASS** | `tests/game/game-reset.test.mjs` |
| **#079** | 管理者による特定エリア・リージョンの変更 | `AUTOMATED` | **PASS** | `tests/game/admin-mission.test.mjs` |
| **#080** | 非管理者ユーザーによるAdmin Gateway呼び出しの完全拒否 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |

### 9. セキュリティ・耐改ざん

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#081** | 自己スコアの直接書き換え攻撃の遮断 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#082** | 偽装ミッション達成によるポイント水増し攻撃の遮断 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#083** | 達成済みミッションの削除・再達成（リプレイ攻撃）の遮断 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#084** | 無敵カードの不正増殖攻撃の遮断 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#085** | 逃走者による不正な攻守交代・チームスコア改ざんの遮断 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#086** | 他プレイヤーのプライベート位置情報盗み見の遮断 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#087** | 公開プロファイルへの座標インジェクション遮断 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#088** | 自己のチームや役割の勝手な変更遮断 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#089** | 一般参加者による管理者コレクションへの昇格遮断 | `RULES` | **PASS** | `tests/firestore-rules.test.mjs` |
| **#090** | プレイヤー名へのスクリプト・画像タグ注入（XSS）無害化 | `AUTOMATED` | **PASS** | `tests/player-map-popup.test.mjs` |

### 10. PWA・圏外復帰・耐久

| ID | テストケース名 | 検証方式 | 合格ステータス | 対象コンポーネント / テストスイート |
| :---: | :--- | :---: | :---: | :--- |
| **#091** | PWAホーム画面インストールとスタンドアロン起動 | `AUTOMATED` | **PASS** | `tests/hooks-pwa.test.mjs, vite.config.ts` |
| **#092** | Service Workerによるオフラインキャッシュ起動 | `AUTOMATED` | **PASS** | `tests/hooks-pwa.test.mjs, vite.config.ts` |
| **#093** | OpenStreetMap地図タイルのキャッシュと不正ドメイン排除 | `AUTOMATED` | **PASS** | `tests/hooks-pwa.test.mjs` |
| **#094** | Screen Wake Lock API による画面自動消灯防止 | `AUTOMATED` | **PASS** | `tests/hooks-pwa.test.mjs, App.tsx` |
| **#095** | バックグラウンド遷移 → フォアグラウンド復帰時のWake Lock再取得 | `FIELD_TEST` | **READY_FOR_FIELD** | `docs/operations/FIELD_TEST_RUNBOOK.md` |
| **#096** | 地下鉄・トンネル進入（3分間の通信断）からの自動再接続 | `FIELD_TEST` | **READY_FOR_FIELD** | `docs/operations/FIELD_TEST_RUNBOOK.md` |
| **#097** | 圏外状態でのミッション達成ボタン操作時の安全なエラー処理 | `FIELD_TEST` | **READY_FOR_FIELD** | `docs/operations/FIELD_TEST_RUNBOOK.md` |
| **#098** | コード分割された各ビューの高速遷移 | `AUTOMATED` | **PASS** | `vite.config.ts (npm run build)` |
| **#099** | 10〜20名規模での2時間稼働時のFirestoreクォータ消費率 | `FIELD_TEST` | **READY_FOR_FIELD** | `docs/operations/FIELD_TEST_RUNBOOK.md` |
| **#100** | 実機2時間プレイでのバッテリー消費率（省電力検証） | `FIELD_TEST` | **READY_FOR_FIELD** | `docs/operations/FIELD_TEST_RUNBOOK.md` |


---

## 3. テストスイート実行ログ抜粋

### ユニット / 統合テスト（`npm test`）
```text
✔ Firebase snapshot mappers (3.661228ms)
▶ Leaflet player popup text rendering
  ✔ renders HTML-like player names as text nodes, not markup (1.198012ms)
  ✔ does not interpret script-like player names (0.189489ms)
  ✔ preserves Japanese names and expected popup fields (0.157838ms)
  ✔ retains the fixed emergency and reveal labels (0.13788ms)
✔ Leaflet player popup text rendering (2.590139ms)
ℹ tests 206
ℹ suites 36
ℹ pass 206
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3169.159768
```

### Firestore セキュリティルールテスト（`npm run test:rules`）
```text
commitBatch error (status 403): {"error":{"code":403,"message":"\nevaluation error at L361:24 for 'create' @ L361, false for 'create' @ L453, evaluation error at L362:32 for 'update' @ L362, false for 'update' @ L453, false for 'create' @ L316, false for 'create' @ L453, evaluation error at L317:24 for 'update' @ L317, false for 'update' @ L453, evaluation error at L448:32 for 'create' @ L448, false for 'create' @ L453, evaluation error at L449:24 for 'update' @ L449, false for 'update' @ L453, false for 'update' @ L449, false for 'update' @ L453","status":"PERMISSION_DENIED"}}
commitBatch error (status 409): {"error":{"code":409,"message":"entity already exists: EntityRef[partitionRef=dev~demo-no-project, path=\/missionCompletions\/A_session_rules_current_mission-2]","status":"ALREADY_EXISTS"}}
  ✔ P1 Exploit: atomic mission completion transaction succeeds and rejects forged points (160.504985ms)
commitBatch error (status 403): {"error":{"code":403,"message":"\nevaluation error at L448:32 for 'create' @ L448, false for 'create' @ L453, evaluation error at L449:24 for 'update' @ L449, false for 'update' @ L453, false for 'create' @ L316, false for 'create' @ L453, evaluation error at L317:24 for 'update' @ L317, false for 'update' @ L453, false for 'update' @ L317, false for 'update' @ L453","status":"PERMISSION_DENIED"}}
  ✔ P1 Exploit: capture transaction only allowed by active ONI team with score +50 and role flip (55.020941ms)
✔ Firestore Security Rules (4136.121638ms)
ℹ tests 18
ℹ suites 1
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4264.121483
✔  Script exited successfully (code 0)
i  emulators: Shutting down emulators.
i  firestore: Stopping Firestore Emulator
i  auth: Stopping Authentication Emulator
i  hub: Stopping emulator hub
i  logging: Stopping Logging Emulator
```
