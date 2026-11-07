# Transit Tag Game / 鉄道鬼ごっこ

公共交通機関を利用した、2チーム対抗の位置情報ゲームを運営するための Web アプリケーションです。
プレイヤーはスマートフォンのブラウザから参加し、管理者は専用ダッシュボードからゲームの進行、ミッション配信、位置公開、スコア管理をリアルタイムに操作します。

> **💡 Firebase Sparkプラン（完全無料版）対応:**
> 本アプリケーションは、クレジットカード登録が必要な有料プラン（Blaze）を不要とし、**完全無料の「Firebase Sparkプラン」のみで本番運用可能なアーキテクチャ**を採用しています。
> ゲームの整合性はクライアントサイド Firestore トランザクション（`runTransaction`）と厳格なセキュリティルール（`firestore.rules`）によって担保されます。
> 詳細は本 README および [SPARK_PLAN.md](SPARK_PLAN.md) を参照してください。

---

## 主な機能

### プレイヤー向け機能
- **簡単参加**: 匿名認証により、アカウント作成不要でチーム（A / B）と名前を入力して即座に参加可能。
- **現在地マップ**: OpenStreetMap / Leaflet によるリアルタイムマップ表示。
- **位置スナップショット公開**: 自分の現在地を 5 分間限定で他プレイヤーへ公開（ミッションや陽動に利用）。
- **捕獲アクション**: 鬼（ONI）が逃走者（RUNNER）に接近した際に捕獲を実行。攻守が交代し、ポイントを獲得。
- **無敵カード**: 逃走者専用アイテム。使用後 10 分間は捕獲を回避。
- **待機モード**: 新幹線移動中などに一時的にゲームから離脱する待機機能（タイマー終了後に自動復帰）。
- **ミッション達成報告**: 管理者から配信されたミッションの達成を報告し、チームおよび個人スコアを獲得（20% の確率で無敵カードのラッキーボーナス）。
- **最終ミッション**: ゲーム終盤（DAY 2 後半）に発生する一発逆転ミッション。
- **Safety（SOS / リタイア）**: 急病・怪我・トラブル時の緊急通報（SOS 発信時は管理者マップへ即座に位置投影）およびリタイア機能。
- **リザルト画面**: ゲーム終了時のスコアおよび勝敗表示。

### 管理者向け機能
- **安全な認証**: メールアドレス / パスワード認証および `admins/{uid}` による厳格なアクセス制御。
- **ゲームセッション管理**: 新規ゲームセッションの初期化および全プレイヤーのセッション紐付け。
- **フェーズ制御**: `PRE_GAME` → `DAY1_ACTIVE` → `DAY1_PAUSED` → `DAY1_ENDED` → `DAY2_ACTIVE` → `DAY2_PAUSED` → `FINAL_MISSION` → `GAME_OVER` の遷移制御。
- **攻守強制交代**: 管理者判断による ONI / RUNNER 役割の強制スイッチ。
- **位置強制公開**: `GLOBAL`（全員）、`TEAM_A`、`TEAM_B` の単位で 1〜30 分間の位置スナップショット強制公開。
- **ミッション管理**: カタログからの手動・ランダム配信、配信モード切替（両チーム同一 `SAME` / 個別 `DIFFERENT`）、ミッション DB 同期。
- **スコア監査補正**: 理由コード（訂正、ボーナス、ペナルティ等）付きのチームスコア補正。
- **プレイヤー復帰支援**: 待機・緊急・リタイア状態のプレイヤーをアクティブ状態へ強制復帰。
- **緊急通報マップ**: SOS を発信したプレイヤーの位置情報を専用画面でリアルタイム監視。
- **マスターリセット**: セッションのリセットプレビューおよび初期状態への安全な一括リセット実行。

### 安全・プライバシー設計
- 通常の位置情報は本人以外閲覧できない `privateLocations/{uid}` にのみ記録。
- 他プレイヤーに共有されるのは、本人が明示的に公開したか管理者が公開した期限付きの `exposedLocations/{uid}` スナップショットのみ。
- SOS 緊急位置は管理者のみが閲覧できる `emergencyLocationProjections/{uid}` に投影。
- バックグラウンドでの追跡は行わず、ブラウザを開いている間のみ位置を更新。

---

## アーキテクチャ

Firebase の無料枠（Sparkプラン）を最大限に活用し、常時課金サーバーや Cloud Functions を一切排除したサーバーレス構成です。

```text
[ プレイヤー / 管理者 ブラウザ ]
  │
  ├─ リアルタイム同期（onSnapshot 読み取り）
  │    ├─ game_config/current （フェーズ、スコア、攻守役割、イベントログ）
  │    ├─ users （参加プレイヤー一覧・ステータス）
  │    ├─ exposedLocations （公開位置スナップショット）
  │    └─ missions / missionCompletions （ミッション達成状況）
  │
  ├─ クライアントサイド トランザクション（runTransaction / writeBatch）
  │    ├─ 捕獲処理（攻守交代、10分待機設定、無敵カード付与、スコア加算）
  │    ├─ 無敵カード発動（10分間保護）
  │    ├─ 待機モード開始・復帰（期限判定と自動復帰）
  │    ├─ ミッション達成記録作成とスコア加算
  │    ├─ SOS発信および緊急位置プロジェクション直接投影
  │    └─ 管理者操作（フェーズ遷移、攻守交代、スコア補正、リセット等）
  │
  └─ クライアント内タイマー + 自己修復リトライ
       └─ WAITING 待機期限到来時の自動復帰

[ Cloud Firestore セキュリティルール (firestore.rules) ]
  ├─ 署名済みトークンおよび admins/{uid} による管理者権限の厳格な検証
  ├─ プレイヤー自身の情報更新における遷移・キー・値の厳密な制限
  ├─ 捕獲時の他者更新における「ONI権限」「攻守交代トランザクション同期」の強制
  ├─ game_config のコアメタデータ（セッション・フェーズ・日）のロックとスコア上限制御
  ├─ ミッション達成の正規カタログ存在確認とポイント改ざん防止
  └─ 緊急位置情報のスキーマ・有効期限・EMERGENCYステータス整合性の強制
```

---

## 技術スタック

| 領域 | 採用技術 | 説明 |
| --- | --- | --- |
| **フロントエンド** | React 19 / TypeScript / Vite 6 | 最新の React と Vite による高速ビルド |
| **スタイリング** | Tailwind CSS 4 | ユーティリティファーストのモダン UI |
| **ルーティング** | React Router 7 (`HashRouter`) | 静的ホスティングに適したハッシュルーティング |
| **地図ライブラリ** | Leaflet 1.9 / OpenStreetMap | 軽量な地図レンダリング（CDN 読み込み） |
| **認証** | Firebase Authentication | 匿名認証（プレイヤー用）およびメール/パスワード（管理者用） |
| **データベース** | Cloud Firestore | リアルタイム同期およびクライアントトランザクション |
| **ホスティング** | Firebase Hosting | 無料枠内でグローバル CDN 配信 |
| **テスト** | Node.js Test Runner (`node:test`) | TypeScript ネイティブ実行による高速単体・統合テスト |

---

## 必要環境

- **Node.js**: 22 以上（22.14 以上推奨）
- **npm**: 10 以上
- **Firebase プロジェクト**: **Sparkプラン（無料版）**
  - Authentication（匿名、メール/パスワード）
  - Cloud Firestore
  - Firebase Hosting
  - ※クレジットカード登録や Cloud Functions の有効化は**不要**です。

---

## セットアップ手順

### 1. リポジトリのクローンと依存関係のインストール

```bash
git clone https://github.com/skyblueao77/transit-tag-game.git
cd transit-tag-game
npm install
```

### 2. Firebase プロジェクトの作成（完全無料）

1. [Firebase Console](https://console.firebase.google.com/) にアクセスし、プロジェクトを新規作成します（デフォルトで **Spark プラン** となります）。
2. **Authentication** を有効化します:
   - 「ログイン方法」タブで **匿名** を有効化（プレイヤー用）。
   - **メール / パスワード** を有効化（管理者用）。
   - 「Users」タブで管理者アカウントを 1 件作成します（例: `admin@example.com`）。
3. **Cloud Firestore** を有効化します:
   - データベースを作成（ロケーション: `asia-northeast1` / 東京 推奨）。
   - セキュリティルールの初期設定は本番モードで作成します。
4. **管理者ドキュメント** を作成します:
   - Firestore のデータタブで `admins` コレクションを作成します。
   - ドキュメント ID に、作成した管理者アカウントの **UID** を指定します。
   - フィールドに `role: "admin"` などを設定して保存します。
5. **Web アプリを登録**:
   - プロジェクト設定 > 「マイアプリ」から Web アプリを追加し、`firebaseConfig` を取得します。

### 3. 環境変数の設定

リポジトリ直下に `.env` または `.env.local` を作成し、取得した設定値を入力します:

```dotenv
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
VITE_FIREBASE_APP_ID=your-app-id
VITE_FIREBASE_MEASUREMENT_ID=your-measurement-id
```

### 4. Firestore 初期設定ドキュメントの作成

Firestore に `game_config/current` ドキュメントを作成します:
- **コレクション ID**: `game_config`
- **ドキュメント ID**: `current`
- **フィールド**:
  - `gameStatus` (string): `"PRE_GAME"`
  - `day` (number): `1`
  - `teamAScore` (number): `0`
  - `teamBScore` (number): `0`
  - `teamARole` (string): `"RUNNER"`
  - `teamBRole` (string): `"ONI"`
  - `missionMode` (string): `"SAME"`
  - `isGameOver` (boolean): `false`
  - `logs` (array): `[]`

### 5. ビルドとデプロイ

```bash
# プロダクションビルド
npm run build

# Firebase CLI ログイン（初回のみ）
npx firebase login

# プロジェクトの指定
npx firebase use your-project-id

# デプロイ（Firestore ルールと Hosting がデプロイされます）
npx firebase deploy
```

> **Note:** `firebase.json` には Cloud Functions の設定が含まれていないため、デプロイ時に Blaze プランへのアップグレードを要求されることはありません。

### 6. 管理者初回操作

デプロイされた Hosting URL にアクセスします:
1. `/#/admin-tk-2026-secret` にアクセスして管理者ログイン。
2. **「Game Session を初期化」** ボタンをクリック（セッション ID が発行され、ゲームが有効化されます）。
3. **「ミッションDB同期」** ボタンをクリック（定義済みミッション 36 件が Firestore に登録されます）。
4. プレイヤーに参加 URL（`/#/map`）を共有。
5. 参加者が揃ったら、フェーズを **「DAY 1 開始」** に切り替えてゲーム開始。

---

## ローカル開発環境

Firebase Emulator Suite を使用して、クラウドに影響を与えずにローカルで開発・テストが可能です:

```bash
# Emulator の起動（Auth, Firestore, Hosting）
npx firebase emulators:start

# 別ターミナルで開発サーバー起動
npm run dev
```

- フロントエンド: `http://localhost:3000`
- Emulator UI: `http://localhost:4000`
- Firestore: `localhost:8080`
- Auth: `localhost:9099`

---

## ゲームルール詳細

### 役割と捕獲
- プレイヤーは **Team A** または **Team B** に所属し、各チームは **ONI**（鬼）または **RUNNER**（逃走者）となります。
- 捕獲は、ゲームがアクティブフェーズ（`DAY1_ACTIVE` / `DAY2_ACTIVE`）で、実行者が ONI、対象が RUNNER、双方が ACTIVE、かつ対象が無敵状態でない場合に成立します。
- 捕獲が成立すると単一トランザクションで以下が同時適用されます:
  - 攻守の反転（ONI チームと RUNNER チームが入れ替わり）
  - 新しい ONI チーム全員が **10 分間 WAITING**（待機モード）
  - 新しい RUNNER チーム全員に **無敵カードを 1 枚付与**
  - 捕獲したチームに **+50pt** 加算
  - 次回位置公開予告時刻の更新

### アイテム・待機
- **無敵カード**: RUNNER のみ使用可能。1 枚消費して **10 分間** 捕獲を無効化。
- **待機モード**: RUNNER がアクティブフェーズで手動開始可能。**60 分間** ゲームから離脱。
- 待機期限（`waitingUntil`）が切れると、クライアントの自動タイマーにより安全に `ACTIVE` へ復帰します。

### ミッション
- **通常ミッション**: 全 32 件（15〜50pt）。管理者が手動またはランダム配信。
- **最終ミッション**: 全 4 件（各 100pt）。管理者が `START_FINAL` 実行時にランダム選択（制限時間 2 時間）。
- 達成報告は 1 セッション・1 チームにつき各ミッション 1 回のみ。
- 達成時にチームスコア・個人スコアへ加算され、20% の確率で無敵カードを獲得。

### 安全管理（Safety）
- 体調不良や機材トラブルの際は **SOS（EMERGENCY）** または **リタイア（RETIRED）** を送信可能。
- SOS 発信時は、最新のプライベート GPS 位置が `emergencyLocationProjections` に即時投影され、管理画面の緊急投影マップでリアルタイムに位置を確認できます。

---

## テストと品質管理

```bash
# TypeScript 型検査
npm run typecheck

# 単体・統合テストの実行（193テスト）
npm test

# 本番ビルド
npm run build

# ビルドプレビュー
npm run preview
```

---

## ディレクトリ構成

```text
.
├── App.tsx                     # メイン画面ルーティング、認証、自動復帰タイマー
├── constants.ts                # 通常ミッション定義、初期設定、カラー定義
├── firestore.rules             # 厳格な Firestore セキュリティルール
├── firebase.json               # Firestore & Hosting 設定（Spark対応）
├── SPARK_PLAN.md               # Sparkプラン移行ガイド
├── rulebook.md                 # ルールブック仕様
├── views/                      # 画面コンポーネント (MapView, AdminView, MissionView, SetupView)
├── src/
│   ├── game/                   # 純粋なドメインロジック（捕獲、役割、時間、スコア、安全管理等）
│   ├── application/            # ユースケースおよび Port/Gateway インターフェース定義
│   └── infrastructure/         # Firebase 実装（clientFirestoreGateways, リアルタイム購読）
├── functions/                  # （旧アーキテクチャ資産 / Sparkプランではデプロイ不要）
└── tests/                      # ドメイン・アプリケーション層の自動テストスイート
```

---

## ライセンス

本プロジェクトは [MIT License](LICENSE) の下で公開されています。
