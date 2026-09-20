# 鉄道鬼ごっこ Web アプリ

鉄道を使ったチーム対抗ゲームのための、位置情報・ミッション・ゲーム進行管理アプリです。
このリポジトリは特定のFirebaseプロジェクトや参加者データを含まない、再利用可能なOSSとして公開することを目的としています。

> 現在は開発中のプロトタイプです。ゲームルール、位置情報の扱い、不正対策は利用者自身の運用に合わせて確認してください。

## 必要環境

- Node.js 20以上を推奨
- Firebaseプロジェクト
- Firebase Authentication
- Cloud Firestore
- Firebase CLI（デプロイする場合）

## セットアップ

### 1. リポジトリを取得して依存関係をインストール

```bash
npm install
```

### 2. Firebaseプロジェクトを作成

Firebase Consoleでプロジェクトを作成し、次を有効化します。

- Authentication
  - 匿名（プレイヤー用）
  - メール/パスワード（管理者用）
- Cloud Firestore
- Firebase Hosting（必要な場合）

WebアプリをFirebaseプロジェクトに登録し、設定値を取得します。

### 3. 環境変数を設定

```bash
copy .env.example .env.local
```

`.env.local`に自分のFirebase Web App設定を入力してください。`.env.local`はGitへコミットしないでください。

### 4. Firebase CLIプロジェクトを選択

個人のFirebaseプロジェクトIDをリポジトリへ固定していません。
Firebase CLIで自分のプロジェクトを選択します。

```bash
firebase login
firebase use --add
```

または、コマンド実行時にプロジェクトを指定します。

```bash
firebase deploy --project YOUR_FIREBASE_PROJECT_ID
```

### 5. Firestore Rulesをデプロイ

```bash
firebase deploy --only firestore:rules --project YOUR_FIREBASE_PROJECT_ID
```

Rulesは、ログイン済みユーザーのみがデータを読めるようにし、ゲーム設定・ミッション・他ユーザーの削除などは管理者だけが実行できる構成です。

### 6. 初期管理者を設定

1. Firebase ConsoleのAuthenticationで、管理者用のメール/パスワードユーザーを作成
2. 作成したユーザーのUIDをコピー
3. Firestoreに次のドキュメントをFirebase Consoleから作成

```text
コレクション: admins
ドキュメントID: 作成した管理者ユーザーのUID
```

ドキュメントのフィールドは空でも構いません。クライアントから`admins`ドキュメントを作成・変更することはRulesで禁止しています。

### 7. 起動

```bash
npm run dev
```

管理者は起動後に`#/admin-tk-2026-secret`へ移動して、Firebase Authenticationで作成した管理者アカウントでログインします。このURLは秘密情報ではなく、認証・認可はFirebase AuthenticationとFirestore Rulesで行います。

### 8. ミッションと初期ゲーム設定

管理者でログイン後、管理画面からミッションをFirestoreへ同期してください。
`game_config/current`が存在しない場合は、管理者権限を持つ状態で初期設定を作成してください。

### 9. ビルド・Hostingデプロイ

```bash
npm run build
firebase deploy --only hosting --project YOUR_FIREBASE_PROJECT_ID
```

## セキュリティ上の注意

- Firebase設定値は`.env.local`で管理してください。
- サービスアカウントJSON、秘密鍵、実データをリポジトリへ追加しないでください。
- 実際の参加者名、位置情報、開催履歴を公開リポジトリへ保存しないでください。
- `firestore.rules`を変更した場合は、意図した権限になっているかFirebase Emulator等で確認してください。
- 管理者権限はFirebase Authenticationのユーザーと`admins/{uid}`の組み合わせで管理します。
- ゲームのスコアや役割変更など、クライアントからの操作を完全に信頼できる設計ではありません。公開後の不正対策は別途検討が必要です。

## Firebase Emulator

```bash
firebase emulators:start
```

ローカルホストで起動した場合、アプリはFirestore/Auth Emulatorへ接続します。

## ライセンス

このプロジェクトは [MIT License](LICENSE) の下で公開します。
