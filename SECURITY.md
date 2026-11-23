# Security Policy

## Supported Versions

現在セキュリティアップデートが提供されているバージョンの一覧です。

| Version | Supported          |
| ------- | ------------------ |
| 1.2.x   | :white_check_mark: |
| < 1.2   | :x:                |

## Reporting a Vulnerability

脆弱性やセキュリティ上の問題を発見された場合は、公開の Issue 等で報告せず、以下の手順でプライベートにご報告ください。

### 報告手順
1. **GitHub Security Advisories** の [Report a vulnerability] ボタンで詳細をお送りください。
2. 報告には以下の情報を含めていただけますようご協力をお願いします：
   - 影響を受けるバージョンやコンポーネント
   - 脆弱性の再現手順・概念実証（PoC）コード
   - 潜在的な影響（特権昇格、情報漏洩など）

### 対応の流れ
- **一次答答**: 報告を受信してから **おおむね48時間以内** に確認の連絡をいたします。
- **調査と修正**: 受理された報告については、状況の確認を行い、パッチの作成およびリリーススケジュールの調整を進めます。
- **公開**: 修正パッチがリリースされた後、適切なセキュリティアドバイザリを発行・公開します。

ご協力ありがとうございます。

## 公開リポジトリ運用・Firebase App Check セキュリティ設定

本リポジトリは公開リポジトリであるため、reCAPTCHA のシークレットキーや実環境の認証情報をリポジトリおよび `.env` に保持しません。ボット対策・不正リクエスト防止は **Firebase App Check（reCAPTCHA Enterprise プロバイダ）** に一本化しています。

> **アーキテクチャ補足**: v1.2 以降の標準本番構成は **Firebase Spark プラン（Cloud Functions 未使用・クライアントトランザクション + `firestore.rules` 強制）** です（`functions/` パッケージは削除され Spark に一本化されました）。

本番環境およびローカル開発環境を運用する際は、以下の手動コンソール設定を必ず実施してください：

1. **reCAPTCHA Enterprise Web キーの作成（本番ドメイン限定）**
   - Google Cloud Console（セキュリティ > reCAPTCHA Enterprise）でウェブサイト用キーを作成する。
   - 許可ドメインには**本番ドメインのみ**（例: `<your-project-id>.web.app`, `<your-project-id>.firebaseapp.com`, 独自ドメイン）を登録し、**`localhost` や `127.0.0.1` は絶対に追加しない**。
   - 発行された公開サイトキーのみを `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY`（ローカルは `.env.local`、CI/CD は GitHub Actions の `vars` / `secrets`）に設定する。シークレットキーは取得・保持しない。
2. **Firebase Web API キーへの HTTP リファラー制限**
   - Google Cloud Console（API とサービス > 認証情報）で Firebase Web API キーを選択し、アプリケーションの制限に「HTTP リファラー（ウェブサイト）」を設定して本番ドメインのみを許可する。
3. **Firebase App Check の登録と強制（Enforcement）**
   - Firebase Console > App Check で対象 Web アプリに reCAPTCHA Enterprise サイトキーを登録する。
   - 本番公開後のメトリクス（検証済みリクエスト率）を確認したうえで、**Cloud Firestore / Firebase Authentication** の App Check 強制（Enforce）を有効化する。
4. **ローカル開発時のデバッグトークン運用**
   - ローカル開発（`localhost`）では本番サイトキーのドメイン許可に `localhost` を追加せず、`.env.local` に `VITE_APPCHECK_DEBUG_TOKEN=true` を設定して開発サーバーを起動する。
   - ブラウザのコンソールに出力される `App Check debug token` をコピーし、Firebase Console > App Check > アプリメニューの「デバッグ トークンを管理（Manage debug tokens）」に登録する（必要に応じて登録済みトークン文字列を `.env.local` の `VITE_APPCHECK_DEBUG_TOKEN` に固定設定する）。
   - `VITE_APPCHECK_DEBUG_TOKEN` は本番ビルドには絶対に含めない（本番ビルドでは `import.meta.env.DEV` ガードによりデバッグトークン初期化コード自体が除去される）。

## 自動セキュリティ検証（CI / GitHub Security）

- **GitHub CodeQL (Default Setup)**: `actions` および `javascript-typescript` に対して静的解析が有効化されています。
- **Dependabot**: `.github/dependabot.yml` により `npm` 依存および `github-actions` ワークフローの更新を毎週チェックし、通常バージョン更新にはクールダウン期間（`cooldown`）と関連アップデート集約（`groups`）を適用してサプライチェーンリスクと PR ノイズを抑えています（セキュリティアップデートは即時通知されます）。
- **二段依存脆弱性チェック & PR レビュー**: `.github/workflows/ci.yml` および `.github/workflows/release.yml` にて、本番依存監査（`npm audit --omit=dev`）に加えて全依存監査（`npm audit --audit-level=moderate`）を実行しています。また PR 時には `dependency-review-action` により新規の脆弱な依存混入を自動ブロックし、全ワークフローで GitHub Actions のフルコミット SHA ピン止めと `persist-credentials: false` を徹底しています。
- **週次定期セキュリティ監査**: `.github/workflows/security-audit.yml` により、コード変更がない期間も毎週自動で依存脆弱性監査（`npm audit --omit=dev` / `npm audit --audit-level=moderate`）、監査リグレッションテスト（`npm run test:audit`）、および Firestore セキュリティルールテスト（`npm run test:rules`）を実行します。
- **Hosting / 入力防御**: `firebase.json` にて HSTS・CSP に加え `Cross-Origin-Opener-Policy: same-origin`・`Cross-Origin-Resource-Policy: same-origin`・`X-Permitted-Cross-Domain-Policies: none` を強制し、管理画面のミッション JSON インポートには 512KB 上限検証を適用しています。
- **ルール・統合・E2E 検証**: `.github/workflows/ci.yml` にて Firestore セキュリティルールテスト（`npm run test:rules`）、エミュレータ結合テスト（`npm run test:integration`）、およびモバイル E2E テスト（`npm run test:e2e:mobile`）を継続実行しています。

