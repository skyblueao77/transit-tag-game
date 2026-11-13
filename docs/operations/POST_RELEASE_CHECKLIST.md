# リリース後運用チェックリスト & ロールバック手順 (Post-Release Checklist & Runbook)

本ドキュメントは、本番環境（Firebase Hosting / Cloud Firestore）へのリリース後に実施する **標準的なポストリリース確認・監視・緊急ロールバック手順** をまとめたものです。

---

## 1. 本番スモークテスト（デプロイ直後 5〜10分以内）

公開 URL（`https://tekkenkobe26haru.web.app`）にアクセスし、以下を最短ルートで確認します。

- [ ] **配信 & PWA 更新確認**
  - トップ画面（`/#/`）が HTTP 200 で表示され、コンソールに未処理エラー（赤いエラー）が出ていないこと。
  - 既存端末で開く場合、Service Worker（Workbox）が新バージョンへ切り替わっていること（必要に応じてスーパーリロード / PWA 再起動）。
  - `manifest.webmanifest` とアプリアイコンが正常に読み込まれること。
- [ ] **認証 & 管理者導線**
  - 管理者画面（`/#/admin`）にログインでき、右上の `/map`・`/mission` プレビュー遷移と `/admin` への復帰が動作すること。
  - テスト用プレイヤーで新規登録 / 再開ログインができ、`users/{uid}` と `privateLocations/{uid}` が作成されること。
- [ ] **主要ゲームフロー（テストセッション上で確認）**
  - フェーズ遷移（`PRE_GAME` → `DAY1_ACTIVE` → `PAUSE` / `RESUME`）でタイマーが正常に停止・再開すること。
  - 位置情報（GPS）の取得・`lastStation` 更新・ミッション一覧表示がエラーなく動作すること。
  - 確認後、テストデータが残らないよう管理者画面から **ゲームリセット** を実施すること。

---

## 2. Firebase Spark プラン監視 & クォータ確認

Firebase Console (`tekkenkobe26haru`) で本番稼働中のリソース消費とエラーを監視します。

| 監視対象 | Spark プラン無料枠（日次目安） | 確認場所 |
| :--- | :--- | :--- |
| **Firestore 読み取り** | 50,000 回 / 日 | Firebase Console → Firestore → 使用量 |
| **Firestore 書き込み** | 20,000 回 / 日 | Firebase Console → Firestore → 使用量 |
| **Firestore 削除** | 20,000 回 / 日 | Firebase Console → Firestore → 使用量 |
| **Hosting 転送量** | 360 MB / 日（10 GB / 月） | Firebase Console → Hosting → 使用量 |
| **Authentication** | 不審な大量登録・エラー急増がないか | Firebase Console → Authentication → Users |

- [ ] **セキュリティルール拒否（PERMISSION_DENIED）の監視**
  - 端末時刻が大きくずれたクライアントや旧キャッシュ端末から `PERMISSION_DENIED` が多発していないか確認（v1.2.0 以降は `serverClock` で自動補正）。

---

## 3. 本番セキュリティ強化（初回または定期点検）

公開 Web アプリとしてクォータ枯渇や不正アクセスを防ぐための推奨設定です。

- [ ] **Firebase API キーの HTTP リファラ制限（Google Cloud Console）**
  - Google Cloud Console →「API とサービス」→「認証情報」→ ブラウザキーに対し、許可リファラを本番ドメイン（`https://tekkenkobe26haru.web.app/*`, `https://tekkenkobe26haru.firebaseapp.com/*` 等）に制限する。
- [ ] **Firebase App Check の導入検討**
  - 本番ドメイン・正当なブラウザからのリクエストのみ Firestore / Auth にアクセスを許可する場合、reCAPTCHA v3 / Enterprise を用いた App Check の有効化を検討する。
- [ ] **依存関係の脆弱性監査**
  - `npm audit --omit=dev` が CI 上でパスしていることを継続確認する。

---

## 4. 緊急ロールバック手順（不具合発生時）

本番リリース後に致命的な不具合が見つかった場合は、修正を待たずに以下のいずれかで即座に切り戻します。

### 方法 A: Firebase Hosting のリリース履歴から即時ロールバック（最速・推奨）
1. Firebase Console → **Hosting** → リリース履歴を開く。
2. 1つ前の安定バージョンの右メニューから **「ロールバック」** をクリック。
   - ※ `firestore.rules` に互換性のない変更が含まれていた場合は、方法 B でルールも合わせて切り戻してください。

### 方法 B: 前バージョンの Git タグから再ビルド・再デプロイ（ルール含む完全切り戻し）
```powershell
git fetch --tags
git checkout v1.1.0
npm ci
node .\node_modules\vite\bin\vite.js build
node .\node_modules\firebase-tools\lib\bin\firebase.js deploy
```

---

## 5. リリース後の課題トリアージ（次期パッチ向け）

- 実機テストや本番運用で気づいた軽微な不具合・UI 改善点・操作上の違和感は、GitHub Issues に記録し、優先度に応じてパッチリリース（例: `v1.2.1`）として対応します。
