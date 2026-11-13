# Firebase 設計 & デプロイガイド

## 1. Firestore データ構造設計（ゼロトラスト & Sparkプラン対応）

すべてのコレクションは `firestore.rules` により最小権限・セッション整合性・トランザクション整合性が強制されています。

### `users/{uid}`（プレイヤー公開プロフィール・ゲーム状態）
- `id` (string): Firebase Auth UID
- `name` (string): 表示名
- `team` (string): `"A"` | `"B"`
- `role` (string): `"ONI"` | `"RUNNER"`
- `color` (string): ヘックスカラーコード
- `score` (number): 個人スコア
- `status` (string): `"ACTIVE"` | `"WAITING"` | `"EMERGENCY"` | `"RETIRED"` | `"CAPTURED"`
- `gameSessionId` (string): 参加中のゲームセッションID
- `lastStation` (string): 申告中の駅名・区間
- `protectionZone` (string): `"NONE"` | `"GREEN_CAR"` | `"SAFE_ZONE"`
- `invincibleCards` / `invincibleUntil` / `waitingUntil` / `shinkansenStartTime` / `shinkansenSegmentCount` / `penaltyRevealUntil`

### `privateLocations/{uid}`（非公開リアルタイム位置情報）
- 本人（`request.auth.uid == uid`）のみ読み書き可能。管理者を含む他ユーザーからの直接参照は不可。
- `latitude` / `longitude` (number), `updatedAt` (timestamp), `gameSessionId` (string)

### `exposedLocations/{uid}`（ゼロトラスト自己投影スナップショット）
- 全体開示・チーム別開示・個別ペナルティ開示中に、プレイヤー端末が自身の座標を期限付きで投影するコレクション。
- `latitude` / `longitude` (number), `revealScope` (`"GLOBAL"` | `"TEAM_A"` | `"TEAM_B"` | `"PENALTY"`), `expiresAt` (timestamp), `gameSessionId` (string)

### `emergencyLocationProjections/{uid}`（SOS緊急位置投影）
- `EMERGENCY` 状態のプレイヤー端末が管理者向けに自己投影（有効期限最大3分）。管理者のみ一覧・閲覧可能。
- `RETIRED` 等への状態遷移を伴うバッチ内でのみ本人による自己削除を許可。

### `game_config/current`（ゲーム全体設定・進行状態）
- `gameSessionId` (string), `gameStatus` (string), `day` (`1` | `2`)
- `teamAScore` / `teamBScore`, `teamARole` / `teamBRole`
- `victoryMode` (`"SURVIVAL"` | `"SCORE_SWAP"`), 各種動的ルールパラメータ（新幹線制限・待機時間・定期開示間隔/時間・ペナルティ時間）
- `broadcastMessage` / `broadcastTime` / `logs`

### `missions/{missionId}` & `missionCompletions/{completionId}`
- ミッション定義およびセッション単位の完了証跡（リプレイ攻撃・二重加点の防止用）。

### `admins/{uid}` & `system/admin_bootstrap`
- `system/admin_bootstrap` の未存在時のみ初回管理者を1回限りアトミック登録。以降は管理者自身の操作のみ許可。

---

## 2. Firebase Hosting & Firestore デプロイ手順

### ステップ 1: Firebase プロジェクトの作成
1. [Firebase Console](https://console.firebase.google.com/) にアクセス。
2. 「プロジェクトを追加」をクリック（無料の Spark プランのまま利用可能）。
3. Authentication で「メール / パスワード」と「匿名」を有効化、Firestore Database を作成（`asia-northeast1` 推奨）。

### ステップ 2: 依存インストールとビルド
```bash
npm ci
npm run build
```

### ステップ 3: ログインとデプロイ
プロジェクトローカルの `firebase-tools`（`npx firebase`）を利用できます。
```bash
npx firebase login
npx firebase use your-project-id
npx firebase deploy
```
※ `firebase.json` に従い `dist/` の Hosting（CSP・セキュリティヘッダー付き）および `firestore.rules` のみがデプロイされます（Cloud Functions は使用しません）。

---

## 3. 実運用のポイント
- **GPS スロットリングとバッテリー節約**: 30m 移動 / 60秒経過 / 5分生存心拍のみ `privateLocations` を更新する設計により、通信回数・バッテリー消費を抑えています。
- **ブラウザ互換性**: `Page Visibility API`・`Wake Lock API`・オフラインキャッシュ（PWA）により電車移動中も安定稼働します。
