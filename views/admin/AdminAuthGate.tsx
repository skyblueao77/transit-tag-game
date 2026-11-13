import type React from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { signInAdmin, setupInitialAdmin } from '../../src/infrastructure/firebase/auth';
import { isFirebaseMisconfigured } from '../../src/infrastructure/firebase/firebaseClient';

interface AdminAuthGateProps {
  isBootstrapCompleted: boolean | null;
  initialSetupMode: boolean;
  onAuthorized: () => void;
  onBootstrapCompleted: () => void;
}

const AdminAuthGate: React.FC<AdminAuthGateProps> = ({
  isBootstrapCompleted,
  initialSetupMode,
  onAuthorized,
  onBootstrapCompleted,
}) => {
  const [adminIdInput, setAdminIdInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [isSetupMode, setIsSetupMode] = useState(initialSetupMode);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (initialSetupMode) {
      setIsSetupMode(true);
    }
  }, [initialSetupMode]);

  return (
    <div className="flex flex-col items-center min-h-[100dvh] bg-slate-900 p-4 py-8 font-sans text-white">
      <div className="w-full max-w-md my-auto">
      {isFirebaseMisconfigured && (
        <div className="w-full mb-4 p-4 bg-red-600/90 border-2 border-red-400 text-white rounded-2xl text-xs font-bold shadow-2xl flex items-start gap-2.5">
          <AlertTriangle size={20} className="shrink-0 text-amber-300 mt-0.5" />
          <div>
            <div className="font-black text-amber-200 mb-0.5">Firebase環境設定エラー</div>
            ⚠️ Firebaseの環境変数（.env）が設定されないままビルドされています。プロジェクトルートの .env ファイルに VITE_FIREBASE_API_KEY 等を設定し、再度 npm run build && npx firebase deploy を実行してください。
          </div>
        </div>
      )}

      <div className="w-full bg-slate-800 p-8 rounded-3xl text-center shadow-2xl border border-slate-700 relative overflow-hidden">
        <div className="w-16 h-16 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-blue-500/30">
          <Lock size={32} className="text-blue-400" />
        </div>
        <h2 className="text-2xl font-black mb-1">
          {isSetupMode ? '初回管理者登録' : '管理者ログイン'}
        </h2>
        <p className="text-xs text-slate-400 font-medium mb-6">
          {isSetupMode
            ? '初回1回限りの管理者アカウントを作成します'
            : 'メールアドレス不要・IDとパスワードで管理画面へ'}
        </p>

        {authError && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/40 text-red-300 rounded-xl text-xs font-bold text-left">
            {authError}
          </div>
        )}

        {!isSetupMode ? (
          <form onSubmit={async e => {
            e.preventDefault();
            setAuthError(null);
            try {
              const authorized = await signInAdmin(adminIdInput, passwordInput);
              if (!authorized) {
                setAuthError('管理者権限が確認できませんでした。IDとパスワードをご確認ください。');
                return;
              }
              onAuthorized();
            } catch (err: unknown) {
              const code = (err as { code?: string })?.code || '';
              if (code === 'auth/operation-not-allowed') {
                setAuthError('⚠️ Firebase Console の「Authentication > ログイン方法」で「メール/パスワード」が有効になっていません。Firebase Console で有効化してください。');
              } else if (code === 'auth/invalid-api-key' || code.includes('api-key-not-valid')) {
                setAuthError('⚠️ Firebase APIキーが正しくありません。.env の VITE_FIREBASE_API_KEY を確認してください。');
              } else if (code === 'permission-denied') {
                setAuthError('⚠️ Firestore セキュリティルールによって拒否されました。npx firebase deploy --only firestore:rules を実行したか確認してください。');
              } else {
                setAuthError('ログインに失敗しました。IDまたはパスワードをご確認ください。');
              }
            }
          }}>
            <div className="text-left mb-3">
              <label htmlFor="admin-id" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-widest">
                管理者ID
              </label>
              <input
                id="admin-id"
                type="text"
                value={adminIdInput}
                onChange={e => setAdminIdInput(e.target.value)}
                className="w-full p-3.5 bg-slate-700/80 rounded-xl text-white font-bold outline-none border-2 border-transparent focus:border-blue-500 text-sm"
                placeholder="例: admin"
                required
              />
            </div>

            <div className="text-left mb-5">
              <label htmlFor="admin-pass" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-widest">
                パスワード
              </label>
              <input
                id="admin-pass"
                type="password"
                value={passwordInput}
                onChange={e => setPasswordInput(e.target.value)}
                className="w-full p-3.5 bg-slate-700/80 rounded-xl text-white font-bold outline-none border-2 border-transparent focus:border-blue-500 text-sm"
                placeholder="パスワード"
                required
              />
            </div>

            <button
              type="submit"
              className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-black shadow-lg transition-all active:scale-95 text-sm"
            >
              ログインする
            </button>

            <div className="mt-5 pt-4 border-t border-slate-700 flex flex-col gap-2">
              {isBootstrapCompleted === false && (
                <button
                  type="button"
                  onClick={() => { setIsSetupMode(true); setAuthError(null); }}
                  className="text-xs font-bold text-emerald-400 hover:text-emerald-300"
                >
                  初めての方はこちら（初期管理者登録）
                </button>
              )}
              <Link to="/" className="text-xs font-medium text-slate-500 hover:text-slate-400">
                ← プレイヤー参加画面へ戻る
              </Link>
            </div>
          </form>
        ) : (
          <form onSubmit={async e => {
            e.preventDefault();
            setAuthError(null);
            if (passwordInput.length < 8) {
              setAuthError('管理者パスワードは8文字以上で設定してください。');
              return;
            }
            try {
              await setupInitialAdmin(adminIdInput, passwordInput);
              onAuthorized();
              onBootstrapCompleted();
              toast.success('管理者アカウントを作成し、ログインしました！');
            } catch (err: unknown) {
              console.error('Setup error:', err);
              const msg = (err as Error)?.message;
              const code = (err as { code?: string })?.code || '';
              if (msg === 'ADMIN_ALREADY_INITIALIZED') {
                setAuthError('初期管理者は既に登録済みです。登録したIDとパスワードでログインしてください。');
                setIsSetupMode(false);
              } else if (msg === 'ADMIN_PASSWORD_TOO_SHORT') {
                setAuthError('管理者パスワードは8文字以上で設定してください。');
              } else if (code === 'auth/operation-not-allowed') {
                setAuthError('⚠️ Firebase Console の「Authentication > ログイン方法」で「メール/パスワード」が有効になっていません。Firebase Console で有効化してください。');
              } else if (code === 'auth/invalid-api-key' || code.includes('api-key-not-valid')) {
                setAuthError('⚠️ Firebase APIキーが正しくありません。.env の VITE_FIREBASE_API_KEY を確認してください。');
              } else if (code === 'permission-denied') {
                setAuthError('⚠️ Firestore セキュリティルールによって拒否されました。npx firebase deploy --only firestore:rules を実行したか確認してください。');
              } else {
                setAuthError('管理者登録に失敗しました。');
              }
            }
          }}>
            <div className="text-left mb-3">
              <label htmlFor="setup-admin-id" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-widest">
                希望する管理者ID
              </label>
              <input
                id="setup-admin-id"
                type="text"
                value={adminIdInput}
                onChange={e => setAdminIdInput(e.target.value)}
                className="w-full p-3 bg-slate-700/80 rounded-xl text-white font-bold outline-none border-2 border-transparent focus:border-blue-500 text-sm"
                placeholder="例: admin"
                required
              />
            </div>

            <div className="text-left mb-5">
              <label htmlFor="setup-password" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-widest">
                管理者パスワード（8文字以上）
              </label>
              <input
                id="setup-password"
                type="password"
                value={passwordInput}
                onChange={e => setPasswordInput(e.target.value)}
                className="w-full p-3 bg-slate-700/80 rounded-xl text-white font-bold outline-none border-2 border-transparent focus:border-blue-500 text-sm"
                placeholder="8文字以上の強力なパスワード"
                minLength={8}
                required
              />
            </div>

            <button
              type="submit"
              className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-black shadow-lg transition-all active:scale-95 text-sm"
            >
              管理者アカウントを作成（初回限定）
            </button>

            <div className="mt-4 pt-3 border-t border-slate-700">
              <button
                type="button"
                onClick={() => { setIsSetupMode(false); setAuthError(null); }}
                className="text-xs font-bold text-slate-400 hover:text-white"
              >
                ← 既存アカウントでログイン
              </button>
            </div>
          </form>
        )}
      </div>
      </div>
    </div>
  );
};

export default AdminAuthGate;
