# Transit Tag Game / 鉄道鬼ごっこ

公共交通機関を利用した、2チーム対抗の位置情報ゲームを運営するための Web アプリです。
プレイヤーはブラウザから参加し、管理者は専用画面からゲームの進行・ミッション・位置公開・スコアを操作します。

> **実装の正本は Firebase 版です。**
> `supabase/` と `docs/migration/` は独立した PoC の土台であり、現在のアプリからは使用していません。
>
> **リリース状態:** 自動検証は CONDITIONAL PASS、本番 rollout は NO-GO です。詳細と未実施の確認項目は
> [RELEASE_READINESS.md](RELEASE_READINESS.md) を参照してください。

## 主な機能

### プレイヤー

- 匿名認証とチーム（A / B）選択によるゲーム参加
- OpenStreetMap / Leaflet による現在地マップ
- 自分の位置を 5 分間だけスナップショット公開
- 鬼（ONI）による逃走者（RUNNER）の捕獲
- 逃走者用の無敵カード、待機（WAITING）状態
- 管理者が配信するミッションの達成報告とチームスコア
- 最終ミッション（制限時間 2 時間）
- SOS（EMERGENCY）とリタイア（RETIRED）
- ゲーム終了時のリザルト画面

### 管理者

- メール / パスワードによる管理者ログイン
- ゲームセッションの初期化
- フェーズ遷移（DAY1 / DAY2 / PAUSE / FINAL / GAME OVER）
- チームの攻守（ONI / RUNNER）強制交代
- 全員またはチーム単位の位置スナップショット強制公開（1〜30 分）
- ミッションのランダム配信・手動配信・ミッション DB 同期
- チームスコアの監査付き補正
- 待機・緊急・リタイア状態からのプレイヤー復帰
- 緊急通報プレイヤーの専用位置マップ
- マスターリセットのプレビュー（現在は実行無効）

### 安全・プライバシー

- 通常の位置情報は本人だけが読める `privateLocations` に保存
- 他プレイヤーに共有されるのは、期限付きの `exposedLocations` スナップショットのみ
- 緊急位置は管理者だけが読める `emergencyLocationProjections` に投影
- 位置情報の更新はブラウザが開いている間のみ。アプリを閉じた状態のバックグラウンド追跡は行いません

## 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| フロントエンド | React 19 / TypeScript / Vite 6 / Tailwind CSS 4 |
| ルーティング | React Router（`HashRouter`） |
| 地図 | Leaflet 1.9（CDN 読み込み）/ OpenStreetMap タイル |
| 認証 | Firebase Authentication（匿名・メール/パスワード） |
| データベース | Cloud Firestore |
| サーバー処理 | Firebase Cloud Functions v2（Node.js 22 / `asia-northeast1`） |
| ホスティング | Firebase Hosting |
| テスト | Node.js `node:test` / Firebase Emulator Suite |
| 将来構想 | Supabase + Vercel（`docs/migration/` の PoC のみ） |

## アーキテクチャ

```text
ブラウザ
  ├─ Firestore 読み取り（onSnapshot でリアルタイム購読）
  ├─ 限定された直接書き込み
  │    ├─ users/{uid} の初回作成・自分の名前変更
  │    ├─ privateLocations/{uid} の自分の位置
  │    └─ exposedLocations/{uid} の自分の公開スナップショット
  └─ Cloud Functions（httpsCallable）
       └─ Firestore トランザクションでゲーム状態を更新

Cloud Functions
  ├─ Callable: 捕獲・ミッション・待機・Safety・管理者操作
  ├─ Firestore Trigger: 緊急位置投影の更新
  └─ Scheduler（毎分）: 待機期限の解除・新幹線超過の検出
```

ゲームの捕獲、ミッション報酬、スコア、フェーズ、管理者操作は **Cloud Functions を正本** としています。
クライアントからの `game_config`、`missions`、`missionCompletions`、管理者状態への直接書き込みは
[firestore.rules](firestore.rules) で禁止しています。

## 必要環境

- **Node.js 22**（22.18 以上を推奨）
- npm 10 以上
- Firebase プロジェクト
  - Authentication（匿名 / メール・パスワード）
  - Cloud Firestore
  - Cloud Functions（デプロイには Blaze プランが必要）
  - Firebase Hosting（公開する場合）
- Firebase Emulator を使う場合は Java 11 以上
- 位置情報を利用するため、HTTPS または `localhost`

## セットアップ

### 1. 依存関係をインストール

```bash
npm ci
npm --prefix functions ci
```

ルートと `functions/` は別々の依存関係を持ちます。両方のインストールが必要です。

### 2. Firebase プロジェクトを準備

Firebase Console でプロジェクトを作成し、次を有効化します。

- Authentication
  - 匿名（プレイヤー用）
  - メール / パスワード（管理者用）
- Cloud Firestore
- Cloud Functions
- Firebase Hosting（必要な場合）

Web アプリを Firebase プロジェクトに登録し、Web アプリ設定を取得します。

### 3. 環境変数を設定

```powershell
# Windows PowerShell
Copy-Item .env.example .env.local
```

```bash
# macOS / Linux
cp .env.example .env.local
```

`.env.local` に Firebase Web App の設定を入力します。

```dotenv
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_MEASUREMENT_ID=
```

`.env.local` は Git へコミットしないでください。Firebase の Web 設定値は公開前提の識別情報ですが、
サービスアカウント JSON、秘密鍵、実データは絶対にリポジトリへ追加しないでください。

### 4. Firebase CLI のプロジェクトを選択

```bash
npx firebase login
npx firebase use --add
```

`.firebaserc` は Git 管理外です。必要な場合は [.firebaserc.example](.firebaserc.example) を参考にしてください。

### 5. 初期管理者を作成

1. Firebase Console の Authentication で、管理者用のメール / パスワードユーザーを作成
2. 作成したユーザーの UID をコピー
3. Firestore に次のドキュメントを作成（フィールドは空で可）

```text
コレクション: admins
ドキュメント ID: 管理者ユーザーの UID
```

`admins/{uid}` はクライアントから作成・変更できません。必ず Firebase Console または
Admin SDK から作成してください。管理者ログイン時には、このドキュメントの存在も確認されます。

### 6. 初期ゲーム設定を作成

Firestore に `game_config/current` を Firebase Console から作成します。
クライアントはこのドキュメントを書き込めないため、初期投入だけは Console または Admin SDK で行います。

最低限必要なフィールドは次の 5 つです。

| フィールド | 型 | 例 |
| --- | --- | --- |
| `gameStatus` | string | `PRE_GAME` |
| `teamAScore` | number | `0` |
| `teamBScore` | number | `0` |
| `teamARole` | string | `RUNNER` |
| `teamBRole` | string | `ONI` |

`teamARole` と `teamBRole` は必ず異なる値にし、片方を `ONI`、もう片方を `RUNNER` にします。
`logs` は任意の配列です。その他の設定値はクライアント側の初期値で補完されます。

```text
gameStatus: "PRE_GAME"
teamAScore: 0
teamBScore: 0
teamARole: "RUNNER"
teamBRole: "ONI"
logs: []
```

`gameSessionId` はこの時点では不要です。管理者画面からセッションを初期化すると書き込まれます。

### 7. Rules と Functions をデプロイ

```bash
npx firebase deploy --only firestore:rules
npx firebase deploy --only functions
```

Cloud Functions は `asia-northeast1`、Node.js 22 で動作します。
ゲーム操作の大部分は Functions 経由のため、Functions をデプロイしないと捕獲・ミッション・管理操作は動きません。

### 8. ビルドと Hosting デプロイ

```bash
npm run build
npx firebase deploy --only hosting
```

Hosting は `dist/` を公開し、すべてのパスを `index.html` へ rewrite します。
画面遷移には `HashRouter` を使用しているため、URL は `#/map` の形式になります。

### 9. 管理者の初回操作

本番環境では手順 8 でデプロイした Hosting の URL を使います。
ローカルの Emulator で確認する場合は、先に手順 10 を実行してください。

1. `#/admin-tk-2026-secret` を開く（例: `https://YOUR_PROJECT.web.app/#/admin-tk-2026-secret`）
2. 手順 5 または Emulator UI で作成した管理者アカウントでログイン
3. **Game Session を初期化** を実行
4. **ミッションDB同期** を実行
5. プレイヤーに参加 URL を共有
6. フェーズを **DAY 1 開始** に変更

セッション初期化は、既に初期化済みの場合は既存セッションを返します。
プレイヤー登録は有効な `gameSessionId` が存在するまで行えません。

管理者 URL の `admin-tk-2026-secret` は秘密情報ではありません。
認証は Firebase Authentication、認可は `admins/{uid}` と Firestore Rules / Functions で行います。

### 10. ローカル起動（Firebase Emulator）

`localhost` / `127.0.0.1` で開くと、アプリは必ず Firebase Emulator へ接続します。
そのため、ローカルで動かす場合は Emulator も起動してください。

```bash
npm --prefix functions run build
npx firebase emulators:start
```

別のターミナルで:

```bash
npm run dev
```

Vite は `http://localhost:3000` で起動します。

- Auth: `127.0.0.1:9099`
- Firestore: `127.0.0.1:8080`
- Functions: `127.0.0.1:5001`
- Emulator UI: `http://127.0.0.1:4000`

Emulator の初回準備:

1. Emulator UI の Authentication に管理者のメール / パスワードユーザーを作成
2. `admins/{uid}` を作成
3. `game_config/current` を作成
4. 管理者画面でセッションを初期化
5. ミッション DB を同期

Functions のコードを変更した場合は、Functions Emulator の再起動または
`npm --prefix functions run build` 後の再読み込みが必要です。

> **注意:** LAN の IP アドレス（例: `http://192.168.x.x:3000`）で開くと、Emulator ではなく
> `.env.local` の Firebase プロジェクトへ接続します。本番プロジェクトの画面確認は Hosting へ
> デプロイして行うのが安全です。

## ゲームルール（現在の実装）

詳細な運用ルールは [rulebook.md](rulebook.md) にあります。
ただしルールブックには構想段階の項目も含まれるため、実装済みの挙動は本 README とコードを優先してください。

### 役割と捕獲

- プレイヤーは Team A / Team B に分かれます。
- 各チームは `ONI`（鬼）または `RUNNER`（逃走者）の役割を持ちます。
- 捕獲できるのは、ゲームがアクティブなフェーズで、次をすべて満たす場合です。
  - 実行者が `ONI`
  - 対象が `RUNNER`
  - 双方が `ACTIVE`
  - 対象が無敵時間中ではない
  - 別チームである
- 捕獲が成立すると、次の処理を 1 つのトランザクションで行います。
  - チームの役割を反転
  - 新しい鬼チームのプレイヤーを **30 分間 WAITING**
  - 新しい逃走者チームのプレイヤーへ **無敵カードを 1 枚追加**
  - 捕獲したチームへ **50pt** 加算
- 管理者の「攻守を強制交代」でも役割が反転し、新しい鬼チームは 30 分間 WAITING になります。
- `WAITING`、`EMERGENCY`、`RETIRED`、`CAPTURED` のプレイヤーは捕獲できません。

### 位置情報の公開

- 自分の現在地は `privateLocations/{uid}` に保存され、本人だけが読み取れます。
- プレイヤーが位置公開を実行すると、その時点の座標を **5 分間** のスナップショットとして保存します。
  - 公開後に移動しても、地図上のピンは公開時点の位置に残ります。
  - スナップショットはログイン済みの参加者と管理者が閲覧できます。
- 管理者は `GLOBAL`、`TEAM_A`、`TEAM_B` の単位で **1〜30 分** の強制公開を行えます。
- 現在のコードには、一定間隔で自動的に全員の位置を公開する処理はありません。
  `nextRevealTime` はカウントダウン表示用の設定値です。
- `EMERGENCY` / `RETIRED` のプレイヤーは通常の公開対象から除外され、
  緊急位置は管理者専用の投影データとして扱われます。

### ミッション

- 通常ミッションは [constants.ts](constants.ts) に 32 件定義されています（15〜50pt）。
- 最終ミッションは [src/game/finalMissions.ts](src/game/finalMissions.ts) に 4 件定義されています（各 100pt）。
- 管理者は通常ミッションをランダムまたは手動で配信できます。
  - `SAME`: 両チームに同じミッション
  - `DIFFERENT`: チームごとに別のミッション
- 同じセッション・同じチーム・同じミッションの達成は 1 回だけです。
- 達成時はチームスコアと個人スコアの両方にポイントが加算されます。
- 20% の確率で無敵カードを追加獲得します（LUCKY）。
- 最終ミッションは管理者が `START_FINAL` を実行したときに 4 件からランダムに選ばれ、
  制限時間は 2 時間です。
- **現在のミッション達成は自己申告です。** 写真アップロード、GPS 半径判定、座標検証は行いません。
  写真や証跡の確認は運用側（LINE 等）で行ってください。

### 無敵カードと待機

- 無敵カードは `RUNNER` のみ使用できます。
- 使用するとカードを 1 枚消費し、**30 分間** 捕獲されなくなります。
- 新幹線待機ボタンは `RUNNER` がアクティブフェーズで使用でき、**1 時間** の WAITING に入ります。
- `shinkansenStartTime` が記録されているプレイヤーは、2.5 時間を超えると
  毎分実行される Scheduler が **1 時間の WAITING** へ移行させます。
- 待機期限が切れると、Scheduler またはクライアントから復帰要求が出されます。
- `PAUSED` 中は捕獲・ミッション・位置公開などの操作を停止しますが、
  待機や無敵の期限は実時間で進みます。

### フェーズ

```text
PRE_GAME
  └─ START_DAY1 ─→ DAY1_ACTIVE
                     ├─ PAUSE  ─→ DAY1_PAUSED ─ RESUME ─→ DAY1_ACTIVE
                     └─ END_DAY1 ─→ DAY1_ENDED
                                      └─ START_DAY2 ─→ DAY2_ACTIVE
                                                         ├─ PAUSE ─→ DAY2_PAUSED ─ RESUME ─→ DAY2_ACTIVE
                                                         └─ START_FINAL ─→ FINAL_MISSION
                                                                             └─ END_GAME ─→ GAME_OVER
```

| フェーズ | 主な挙動 |
| --- | --- |
| `PRE_GAME` | 開始前。プレイヤー登録は可能だがゲーム操作は停止 |
| `DAY1_ACTIVE` / `DAY2_ACTIVE` | 捕獲・ミッション・位置公開が有効 |
| `DAY1_PAUSED` / `DAY2_PAUSED` | 操作停止。プレイヤーには中断オーバーレイを表示 |
| `DAY1_ENDED` | 1 日目終了。プレイヤー画面は待機表示 |
| `FINAL_MISSION` | 最終ミッション中。通常ミッションは完了不可 |
| `GAME_OVER` | リザルト表示。終了時点で `RUNNER` のチームを勝者として表示 |

### Safety（SOS / リタイア）

- SOS は `EMERGENCY`、リタイアは `RETIRED` として記録します。
- `EMERGENCY` の間は 60 秒ごとに位置を更新し、管理者向けの投影データを更新します。
- 位置の精度が 400m を超える場合は更新を送信しません。
- リタイアはプレイヤー側から取り消せません。管理者が復帰させる必要があります。
- 緊急位置の投影は Firestore Trigger に依存するため、即時配信を保証するものではありません。
  緊急時はアプリ外でも運営へ連絡できる運用にしてください。

## 画面と URL

| URL | 画面 | 内容 |
| --- | --- | --- |
| `#/map` | MapView | 地図、捕獲、無敵カード、待機、位置状態 |
| `#/mission` | MissionView | 配信ミッション、最終ミッション、位置公開 |
| `#/admin-tk-2026-secret` | AdminView | 管理者ログインと運営操作 |
| その他 | MapView | `#/map` へリダイレクト |

## Firestore データモデル

| パス | 用途 | クライアント権限 |
| --- | --- | --- |
| `game_config/current` | フェーズ、スコア、役割、ミッション、公開期限、ログ、セッション | ログイン済みが読み取り。書き込みは Functions のみ |
| `users/{uid}` | プレイヤー情報、状態、スコア、無敵カード | ログイン済みが読み取り。本人の初回作成・名前変更のみ |
| `privateLocations/{uid}` | 本人の最新 GPS 位置 | 本人のみ読み書き |
| `exposedLocations/{uid}` | 期限付きの公開スナップショット | 参加者・管理者が読み取り。書き込みは本人の公開時のみ |
| `emergencyLocationProjections/{uid}` | 緊急プレイヤーの管理者向け位置投影 | 管理者のみ読み取り。書き込みは Functions のみ |
| `missions/{missionId}` | 正規ミッションカタログ | ログイン済みが読み取り。管理者の同期 Function が更新 |
| `missionCompletions/{completionId}` | セッション・チーム・ミッション単位の達成記録 | ログイン済みが読み取り。Functions が作成 |
| `admins/{uid}` | 管理者権限 | 本人のみ読み取り。Console / Admin SDK のみ作成 |
| `admins/{uid}/...Requests/{requestId}` | 管理操作の冪等性レシート | クライアントからはアクセス不可 |

> `firestore_design.md` に記載されている `location_logs` は現在の実装では使用していません。
> 現在のイベントログは `game_config/current.logs` に最大 200 件保持されます。

## Cloud Functions

すべて `asia-northeast1` にデプロイされます。

### プレイヤー向け Callable

- `capturePlayer`
- `completeMission`
- `activateInvincibility`
- `startWaiting`
- `resumeWaiting`
- `requestSafetyAction`

### 管理者向け Callable

- `initializeGameSession`
- `transitionGamePhase`
- `swapTeamRoles`
- `resumePlayer`
- `revealPlayerLocations`
- `setMissionMode`
- `assignMissions`
- `syncMissionCatalog`
- `adjustTeamScore`
- `prepareGameReset`
- `executeGameReset`

### バックグラウンド処理

- `processWaitingLifecycleSchedule`（毎分）
- `onPrivateLocationWritten`（`privateLocations/{uid}` の書き込み時）
- `onPlayerWritten`（`users/{uid}` の書き込み時）

Callable は認証を必須とし、管理者操作では `admins/{uid}` を確認します。
ゲーム操作は `expectedSessionId` で現在のセッションとの一致を検証します。
管理操作の多くは `requestId` による冪等性レシートを持ち、同じリクエストの再送で二重実行しません。

## テスト

```bash
npm run typecheck       # TypeScript 型チェック
npm test                # ドメイン / アプリケーションの単体テスト
npm run test:rules      # Firestore Rules テスト（Emulator 起動）
npm run test:functions  # Functions 単体テスト + Emulator 統合テスト
npm run build           # フロントエンド本番ビルド
npm run preview         # ビルド結果のプレビュー
```

- ルートのテストは Node.js 22 の TypeScript 実行を利用します。
- `test:rules` と `test:functions` は Firebase Emulator と Java が必要です。
- `test:functions` はビルドと多数の統合テストを実行するため、完了まで時間がかかります。
- 検証済みの構成と既知の制約は [RELEASE_READINESS.md](RELEASE_READINESS.md) を参照してください。

## デプロイ

### 更新時の推奨順序

1. Functions をビルド・デプロイ
2. フロントエンドをビルド・Hosting へデプロイ
3. 非本番プロジェクトでスモークテスト
4. 問題がないことを確認して Firestore Rules をデプロイ

```bash
npm --prefix functions run build
npx firebase deploy --only functions --project YOUR_FIREBASE_PROJECT_ID

npm run build
npx firebase deploy --only hosting --project YOUR_FIREBASE_PROJECT_ID

# スモークテスト後
npx firebase deploy --only firestore:rules --project YOUR_FIREBASE_PROJECT_ID
```

Rules を Functions / クライアントより先にデプロイすると、旧クライアントの直接書き込みが拒否されて
ゲームが停止する可能性があります。更新時はこの順序を守ってください。

## セキュリティとプライバシー

- Firestore Rules はデフォルト拒否です。
- ゲーム状態の更新は Cloud Functions のトランザクションに限定しています。
- 管理者権限は Firebase Authentication のユーザーと `admins/{uid}` の組み合わせで判定します。
- 管理 URL は秘密ではありません。URL を知っているだけでは管理操作はできません。
- 位置情報は用途別にコレクションを分離し、通常位置は本人、緊急位置は管理者だけが読めるようにしています。
- サービスアカウント JSON、秘密鍵、`.env.local`、実参加者データを Git や公開 Issue へ載せないでください。
- テストやスクリーンショットには架空のプレイヤー名・座標を使用してください。
- GPS の偽装や端末外での物理的な不正を完全に防ぐ仕組みはありません。
  捕獲・ミッション・スコアのサーバー検証は行いますが、現地での本人確認は運用で担保してください。

## トラブルシューティング

- **セッション初期化が `CONFIG_NOT_FOUND` で失敗する**  
  `game_config/current` が存在するか、`gameStatus` / `teamAScore` / `teamBScore` / `teamARole` / `teamBRole` が正しい型で入っているか確認してください。

- **管理者ログイン直後にログアウトされる**  
  `admins/{管理者UID}` が存在するか確認してください。存在しない場合、`signInAdmin` は意図的にサインアウトします。

- **捕獲・ミッション・管理操作だけが失敗する**  
  Cloud Functions がデプロイされているか、リージョンが `asia-northeast1` か、Functions のログにエラーが出ていないか確認してください。

- **`permission-denied` になる**  
  `firestore.rules` が最新か、ログイン済みか、`gameSessionId` が現在のセッションと一致しているか確認してください。

- **位置情報を取得できない**  
  HTTPS または `localhost` で開いているか、ブラウザの位置情報権限を許可しているか確認してください。

- **Emulator に接続されない**  
  URL が `localhost` または `127.0.0.1` か確認してください。LAN IP では Emulator に接続されません。

## 現在の制限

- 開発中のプロトタイプであり、本番運用前の staging スモークテストやブラウザ offline / reconnect 検証は未実施です。
- マスターリセットは **Preview のみ** です。UI からの実行ボタンは無効化されています。
- プレイヤーの個別削除、個別ロール変更、ペナルティルーレット、管理者からの通知送信は現在利用できません。
- ミッション完了は自己申告で、写真アップロードや GPS 半径判定はありません。
- 一定間隔で自動的に位置を公開する処理はありません。公開はプレイヤー操作または管理者操作で行います。
- 緊急位置の投影は Firestore Trigger 依存で、完了までの時間を保証しません。
- 管理操作のレシートや期限切れスナップショットの TTL 自動削除は未実装です。
- フロントエンドのバンドルサイズ警告（500KB 超）が残っています。

## Supabase PoC について

`supabase/` には、将来の Supabase 移行を検討するための独立した PoC 基盤があります。

- 対象は `poc_*` テーブルと RLS / RPC の検証用スキーマです。
- 現在のゲームデータや Firebase の `game_config/current` を再現したものではありません。
- アプリは Supabase に接続していません。
- 実データ、実ユーザー、実位置情報は使用しないでください。
- Firebase 実装が引き続き正本です。

関連ドキュメント:

- [移行方針 ADR](docs/migration/ADR-001-SUPABASE-DEPLOYMENT-MODEL.md)
- [Firebase → Supabase マッピング](docs/migration/FIREBASE_TO_SUPABASE_MAP.md)
- [PoC 実行手順](docs/migration/HOSTED_POC_RUNBOOK.md)
- [PoC 検証計画](docs/migration/HOSTED_POC_VALIDATION.md)
- [非エンジニア向けインストール構想](docs/migration/NON_ENGINEER_INSTALLATION.md)

## ディレクトリ構成

```text
.
├─ App.tsx                     # 画面分岐、認証、リアルタイム購読、ゲーム操作の接続
├─ views/                      # Map / Mission / Admin / Setup などの画面
├─ src/
│  ├─ game/                    # 純粋なゲームドメイン（役割、捕獲、時間、スコア等）
│  ├─ application/             # ユースケースと Port / Gateway 定義
│  └─ infrastructure/          # Firebase 実装、購読、位置ハートビート
├─ functions/
│  ├─ src/                     # Callable / Trigger / Scheduler とサーバー側サービス
│  └─ test/                    # Functions の単体・統合テスト
├─ tests/                      # ドメイン・アプリケーション・Rules のテスト
├─ supabase/                   # 独立した Supabase PoC（アプリ未接続）
├─ docs/migration/             # 移行検討ドキュメント
├─ firestore.rules             # Firestore セキュリティルール
├─ firebase.json               # Functions / Firestore / Hosting / Emulator 設定
├─ constants.ts                # ミッション、初期設定、チームカラー
└─ types.ts                    # クライアントの共有型
```

## 関連ドキュメント

- [ゲームルールブック](rulebook.md)
- [Firebase 設計メモ](firestore_design.md)（一部は旧設計）
- [リリース準備記録](RELEASE_READINESS.md)
- [セキュリティポリシー](SECURITY.md)
- [Supabase 移行検討](docs/migration/)

## ライセンス

このプロジェクトは [MIT License](LICENSE) の下で公開します。
