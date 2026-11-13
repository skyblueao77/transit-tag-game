# Firebase Sparkプラン（完全無料版）対応ガイド

本アプリケーションは、Firebaseの有料プラン（Blaze / 従量課金 / クレジットカード登録必須）を必要とせず、**完全無料の「Sparkプラン」のみでTransit Tag Game（鉄道鬼ごっこ）を運用できるよう最適化**されています。

---

## 1. 変更点とアーキテクチャ

### 従来の課題（Blazeプランが必要だった理由）
従来の実装では、ゲームの進行（捕獲、ミッション達成、無敵カード、フェーズ遷移、待機復帰、SOS投影など）をすべて **Firebase Cloud Functions**（Callable関数、スケジュールCron関数、FirestoreバックグラウンドTrigger）で実行していました。
Google Cloud / Firebaseの仕様上、Cloud Functionsの利用・デプロイにはクレジットカードを登録したBlazeプランが必須となっていました。

### Sparkプラン対応の改修内容

| 機能 | 従来（Blazeプラン / Cloud Functions） | Sparkプラン対応（現行構成 / 完全無料） |
| :--- | :--- | :--- |
| **ゲーム操作（捕獲・ミッション・無敵）** | `httpsCallable` → Cloud Functions | Firestore クライアントトランザクション（`runTransaction`）で直接実行 |
| **管理者操作（フェーズ変更・攻守交代等）** | `httpsCallable` → Cloud Functions | Firestore クライアントトランザクション（`runTransaction`）で直接実行 |
| **待機モード自動復帰** | Cloud Functions Scheduler (Cron 1分毎) | クライアント内のリアルタイムタイマーによる自動復帰 |
| **SOS位置情報投影** | Firestore Background Trigger | プレイヤー端末からの直接 Firestore 投影（管理者マップへリアルタイム配信） |
| **セキュリティルール** | クライアント直接書き込み全拒否 | `firestore.rules` で認証済み参加者・管理者の権限を厳密に制御 |
| **デプロイ設定** | `functions` 設定を含むため有料版を要求 | `firebase.json` を Hosting + Firestore のみに構成（無料版で即デプロイ可） |

---

## 2. Firebase プロジェクトのセットアップ（クレジットカード不要）

### Step 1: Firebase プロジェクトを作成
1. [Firebase Console](https://console.firebase.google.com/) にアクセスし、Googleアカウントでログインします。
2. **「プロジェクトを追加」** をクリックし、任意のプロジェクト名を入力します。
3. Google アナリティクスは必要に応じて有効/無効を選択し、作成を完了します（デフォルトで **Spark プラン** となります）。

### Step 2: Authentication の有効化
1. 左メニューの **「構築」 > 「Authentication」** を開きます。
2. **「始める」** をクリックします。
3. **「ログイン方法」** タブから以下を有効にします:
   - **メール / パスワード**: 有効にする（プレイヤー・管理者ともに個人メールアドレス不要で、簡単なユーザーIDとパスワードで認証するために使用されます）
   - **匿名**: 有効にする（必要に応じたフォールバック用）

### Step 3: Cloud Firestore の有効化
1. 左メニューの **「構築」 > 「Firestore Database」** を開きます。
2. **「データベースの作成」** をクリックします。
3. ロケーションを選択します（例: `asia-northeast1` / 東京）。
4. セキュリティルールの初期設定は「本番環境モード」を選択して作成します（後ほどデプロイ時に本リポジトリのルールが適用されます）。

### Step 4: アプリ画面からの管理者初期セットアップ（コンソール作業不要！）
FirebaseコンソールでコレクションやUIDを手動登録する必要はありません。
1. デプロイしたアプリ（またはローカル起動時）の `/#/admin` をブラウザで開きます。
2. 画面上部の **「👉 初めての方: 初回管理者セットアップ」** をクリックします。
3. 任意の **管理者ID**（例: `admin`）、**パスワード**（8文字以上）を入力して「管理者アカウントを作成」をクリックします（Firestoreルールの初回限定ブートストラップ機能により1人目のみ自動昇格され、以降の不正昇格はブロックされます）。
4. ログイン後、**「🚀 初期セットアップウィザード（1クリック）」** を実行するだけで、セッション初期化と36件の標準ミッション同期が瞬時に完了します。

### Step 5: Web アプリの登録と環境変数設定
1. プロジェクトのホーム（「プロジェクトの概要」）で、歯車アイコン > **「プロジェクトの設定」** を開きます。
2. 「マイアプリ」の **「Web（`</>` アイコン）」** をクリックしてアプリを登録します。
3. 表示される `firebaseConfig` の値をコピーします。
4. 本リポジトリのルートに `.env` ファイルを作成し、環境変数を設定します:
   ```env
   VITE_FIREBASE_API_KEY=your-api-key
   VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project-id
   VITE_FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
   VITE_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
   VITE_FIREBASE_APP_ID=your-app-id
   VITE_FIREBASE_MEASUREMENT_ID=your-measurement-id
   ```

---

## 3. ビルドとデプロイ（完全無料）

### 1. ビルド
```bash
npm install
npm run build
```

### 2. Firebase へのデプロイ
```bash
# Firebase CLI にログイン（初回のみ）
npx firebase login

# プロジェクトを設定
npx firebase use your-project-id

# デプロイ（Hosting と Firestore ルールのみデプロイされます）
npx firebase deploy
```

> **注意:** Cloud Functions はデプロイされないため、Blaze プランのアップグレード警告やクレジットカードの入力画面は一切表示されません。

---

## 4. ローカル開発（エミュレータ）

ローカル環境でも Cloud Functions なしでエミュレータを起動してテスト可能です:

```bash
# Auth + Firestore + Hosting + UI エミュレータの起動
npx firebase emulators:start

# 別ターミナルで開発サーバー起動
npm run dev
```
