
# Firebase 設計 & デプロイガイド

## 1. Firestore データ構造設計

### `users` コレクション (全ユーザー)
- `id` (string): ユーザーID
- `name` (string): 表示名
- `role` (string): "ONI" | "RUNNER"
- `team` (string): "A", "B", "鬼"など
- `color` (string): ヘックスコード
- `score` (number): ポイント
- `lastLocation` (geopoint): 現在地
- `lastUpdate` (timestamp): 更新日時
- `status` (string): "ACTIVE" | "CAPTURED"

### `location_logs` コレクション (移動軌跡用)
- `userId` (string): ユーザーID
- `location` (geopoint): 座標
- `timestamp` (timestamp): 打刻日時

### `game_config` コレクション (単一ドキュメント `current`)
- `currentArea` (string): "関東" | "東北"
- `announcement` (string): 緊急メッセージ
- `isGameEnded` (boolean): 終了フラグ
- `day` (number): 1 | 2

### `missions` コレクション (固定データ)
- `area` (string): 地域
- `title` (string): 内容
- `points` (number): 付与ポイント
- `location` (geopoint): 座標
- `type` (string): "CHECKIN" | "PHOTO"

---

## 2. Firebase Hosting デプロイ手順

初心者の方でも以下の 5 ステップでデプロイ可能です。

### ステップ 1: Firebase プロジェクトの作成
1. [Firebase Console](https://console.firebase.google.com/) にアクセス。
2. 「プロジェクトを追加」をクリック。
3. Sparkプラン（無料）を選択（クレジットカード不要）。

### ステップ 2: CLI ツールのインストール
PCのターミナル（またはコマンドプロンプト）で実行：
```bash
npm install -g firebase-tools
```

### ステップ 3: ログインと初期化
```bash
firebase login
firebase init hosting
```
- `What do you want to use as your public directory?` → `dist` と入力。
- `Configure as a single-page app?` → `Yes` を選択。

### ステップ 4: アプリのビルド
```bash
npm run build
```

### ステップ 5: デプロイ！
```bash
firebase deploy --only hosting
```
表示された URL にアクセスすれば、世界中からあなたのアプリが利用可能になります。

---

## 3. 実運用のアドバイス
- **バッテリー消費**: 逃走者が移動中に常にブラウザを開いているとバッテリーを消費します。移動中は閉じ、駅に着いた時だけ開いて「更新」させる運用がベストです。
- **不正対策**: 管理者画面からスコアの直接編集機能を追加しておくと、写真ミッションの不正（全く違う場所の写真を上げる等）を後から修正できます。
