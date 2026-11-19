import type React from 'react';
import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { User } from '../types';
import { Users, Train, Shield, LogIn, UserPlus, UserCheck, AlertTriangle, KeyRound } from 'lucide-react';
import { isFirebaseMisconfigured } from '../src/infrastructure/firebase/firebaseClient';
import { loginPlayerAccount, registerPlayerAccount } from '../src/infrastructure/firebase/playerSetup';
import { getUtf8ByteLength } from '../src/game/utf8';

interface Props {
  onComplete: (user: User) => void;
  gameSessionId?: string;
  isAuthenticated?: boolean;
}

const SetupView: React.FC<Props> = ({ onComplete, gameSessionId, isAuthenticated = false }) => {
  const [searchParams] = useSearchParams();
  const initialJoinCode = (() => {
    const fromHash = searchParams.get('join');
    if (fromHash) return fromHash.trim();
    if (typeof window !== 'undefined') {
      const fromWindow = new URLSearchParams(window.location.search).get('join');
      if (fromWindow) return fromWindow.trim();
    }
    return '';
  })();

  const [mode, setMode] = useState<'REGISTER' | 'LOGIN'>('REGISTER');
  const [joinCode, setJoinCode] = useState(initialJoinCode);
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [team, setTeam] = useState<'A' | 'B'>('A');
  const [consentLocationPrivacy, setConsentLocationPrivacy] = useState(false);
  const [consentSafetyRules, setConsentSafetyRules] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const DEFAULT_LAT = 35.6812;
  const DEFAULT_LNG = 139.7671;

  // HashRouter クエリ (?join=...) 変化時にも追従
  useEffect(() => {
    const fromHash = searchParams.get('join')?.trim();
    if (fromHash && !joinCode) {
      setJoinCode(fromHash);
    }
  }, [searchParams, joinCode]);

  const readCurrentPositionBestEffort = (): Promise<{ lat: number; lng: number } | null> => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 60_000 },
      );
    });
  };

  const getFriendlyAuthError = (err: unknown): string => {
    const code = (err as { code?: string })?.code || '';
    if (code === 'auth/operation-not-allowed') {
      return '⚠️ Firebase Console の「Authentication > ログイン方法」で「メール/パスワード」が有効になっていません。Firebase Console で有効化してください。';
    }
    if (code === 'auth/invalid-api-key' || code.includes('api-key-not-valid')) {
      return '⚠️ Firebase APIキーが正しくありません。.env の VITE_FIREBASE_API_KEY を確認してください。';
    }
    if (code === 'permission-denied') {
      return '⚠️ Firestore セキュリティルールによって拒否されました。npx firebase deploy --only firestore:rules を実行したか確認してください。';
    }
    if (code === 'auth/email-already-in-use') {
      return 'このユーザーIDは既に登録されています。「再開ログイン」タブからログインするか、別のIDを入力してください。';
    }
    if (code === 'auth/weak-password') {
      return 'パスワードは6文字以上で入力してください。';
    }
    if (code === 'auth/invalid-credential' || code === 'auth/user-not-found' || code === 'auth/wrong-password') {
      return 'ログインに失敗しました。ユーザーIDとパスワードをご確認ください。';
    }
    return '通信エラーまたは登録処理に失敗しました。電波環境や入力内容をご確認ください。';
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim() || !userId.trim() || !password.trim() || !name.trim() || isSubmitting) return;
    if (!consentLocationPrivacy || !consentSafetyRules) {
      toast.error('位置情報の利用・削除方針および安全ルールへの同意チェックが必要です。');
      return;
    }
    if (getUtf8ByteLength(name.trim()) > 80) {
      toast.error('ニックネームが長すぎます（日本語約26文字／80バイト以内で入力してください）。');
      return;
    }
    if (password.length < 6) {
      toast.error('パスワードは6文字以上で入力してください。');
      return;
    }

    setIsSubmitting(true);
    try {
      const measuredPos = await readCurrentPositionBestEffort();
      const posToSave = measuredPos ?? { lat: DEFAULT_LAT, lng: DEFAULT_LNG };
      const result = await registerPlayerAccount({
        userId,
        password,
        name,
        team,
        joinCode: joinCode.trim(),
        location: { latitude: posToSave.lat, longitude: posToSave.lng },
        fallbackSessionId: gameSessionId,
      });
      if (result.ok === false) {
        switch (result.reason) {
          case 'INVALID_JOIN_CODE':
            toast.error('招待コードの形式が正しくありません。管理者から共有されたURLまたはコードをご確認ください。');
            break;
          case 'JOIN_CODE_INACTIVE':
            toast.error('この招待コードは無効か期限切れです。管理者から最新のQRコードを受け取ってください。');
            break;
          case 'REGISTRATION_CLOSED':
            toast.error('現在、新規参加の受付は停止されています。管理者にお問い合わせください。');
            break;
          case 'SESSION_NOT_INITIALIZED':
            toast.error('ゲームセッション初期化待ちです。管理者が初期化した後に参加してください。');
            break;
        }
        return;
      }
      onComplete(result.user);
    } catch (err: unknown) {
      console.error('Registration error:', err);
      toast.error(getFriendlyAuthError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim() || !password.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const measuredPos = await readCurrentPositionBestEffort();
      const result = await loginPlayerAccount({
        userId,
        password,
        currentLocation: measuredPos
          ? { latitude: measuredPos.lat, longitude: measuredPos.lng }
          : null,
        fallbackSessionId: gameSessionId,
      });

      if (result.ok) {
        onComplete(result.user);
      } else if (result.reason === 'SESSION_MISMATCH') {
        toast.error('前回のゲームセッションのアカウントです。現在のゲームに参加するには「新規エントリー」から新しくユーザーIDを作成してください。');
      } else {
        toast.error('プレイヤー情報が見つかりません。「新規エントリー」タブからアカウントを作成してください。');
      }
    } catch (err: unknown) {
      console.error('Login error:', err);
      toast.error(getFriendlyAuthError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-4 py-8 flex flex-col items-center text-white font-sans">
      <div className="w-full max-w-md my-auto flex flex-col items-center">
      {isFirebaseMisconfigured && (
        <div className="w-full mb-4 p-4 bg-red-600/90 border-2 border-red-400 text-white rounded-2xl text-xs font-bold shadow-2xl flex items-start gap-2.5">
          <AlertTriangle size={20} className="shrink-0 text-amber-300 mt-0.5" />
          <div>
            <div className="font-black text-amber-200 mb-0.5">Firebase環境設定エラー</div>
            ⚠️ Firebaseの環境変数（.env）が設定されないままビルドされています。プロジェクトルートの .env ファイルに VITE_FIREBASE_API_KEY 等を設定し、再度 npm run build && npx firebase deploy を実行してください。
          </div>
        </div>
      )}

      <div className="mb-6 text-center animate-in fade-in zoom-in duration-700">
        <div className="w-20 h-20 bg-white/5 backdrop-blur-xl rounded-[2rem] flex items-center justify-center mx-auto mb-4 shadow-2xl active:scale-90 transition-all border border-white/10">
          <Train size={40} className="text-blue-400 drop-shadow-[0_0_15px_rgba(96,165,250,0.5)]" />
        </div>
        <h1 className="text-3xl font-black italic tracking-tighter mb-1 uppercase bg-clip-text text-transparent bg-gradient-to-b from-white to-slate-400">
          Kyun Tag
        </h1>
        <div className="flex items-center justify-center gap-2 text-blue-400/60 font-black text-[9px] tracking-[0.3em] uppercase">
          <span className="w-6 h-[1px] bg-blue-400/20"></span>
          Railway Tag Game
          <span className="w-6 h-[1px] bg-blue-400/20"></span>
        </div>
      </div>

      <div className="w-full bg-white rounded-[2.5rem] p-7 shadow-[0_20px_50px_rgba(0,0,0,0.3)] text-slate-800 overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-red-500 via-white to-blue-500 opacity-60"></div>

        {/* タブ切り替え（新規参加 / ログイン） */}
        <div className="grid grid-cols-2 p-1 bg-slate-100 rounded-2xl mb-6">
          <button
            type="button"
            onClick={() => setMode('REGISTER')}
            className={`py-2.5 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 transition-all ${
              mode === 'REGISTER'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <UserPlus size={14} /> 新規エントリー
          </button>
          <button
            type="button"
            onClick={() => setMode('LOGIN')}
            className={`py-2.5 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 transition-all ${
              mode === 'LOGIN'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <LogIn size={14} /> 再開ログイン
          </button>
        </div>

        {mode === 'REGISTER' ? (
          <form onSubmit={handleRegister}>
            {/* 招待コード */}
            <div className="mb-4">
              <label htmlFor="reg-join-code" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">
                招待コード（QR読取で自動入力）
              </label>
              <div className="relative">
                <input
                  id="reg-join-code"
                  type="text"
                  value={joinCode}
                  onChange={e => setJoinCode(e.target.value.trim())}
                  className="w-full pl-9 pr-4 py-3 bg-slate-50 rounded-xl border border-slate-200 focus:border-blue-500 focus:bg-white outline-none font-mono font-bold text-xs transition-all"
                  placeholder="管理者共有のQRまたは招待コードを入力"
                  maxLength={128}
                  required
                  disabled={isSubmitting}
                />
                <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              </div>
              <p className="text-[9px] text-slate-400 mt-1 ml-1 font-medium">
                ※招待URLを開くと自動で入力されます
              </p>
            </div>

            {/* ユーザーID */}
            <div className="mb-4">
              <label htmlFor="reg-user-id" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">
                ユーザーID（半角英数字）
              </label>
              <div className="relative">
                <input
                  id="reg-user-id"
                  type="text"
                  value={userId}
                  onChange={e => setUserId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                  className="w-full px-4 py-3 bg-slate-50 rounded-xl border border-slate-200 focus:border-blue-500 focus:bg-white outline-none font-bold text-sm transition-all"
                  placeholder="例: tanaka01"
                  maxLength={30}
                  required
                  disabled={isSubmitting}
                />
              </div>
              <p className="text-[9px] text-slate-400 mt-1 ml-1 font-medium">※メールアドレス不要！このIDで後から復帰できます</p>
            </div>

            {/* パスワード */}
            <div className="mb-4">
              <label htmlFor="reg-password" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">
                パスワード（6文字以上）
              </label>
              <div className="relative">
                <input
                  id="reg-password"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-50 rounded-xl border border-slate-200 focus:border-blue-500 focus:bg-white outline-none font-bold text-sm transition-all"
                  placeholder="6文字以上のパスワード"
                  minLength={6}
                  maxLength={50}
                  required
                  disabled={isSubmitting}
                />
              </div>
            </div>

            {/* ニックネーム */}
            <div className="mb-4">
              <label htmlFor="player-name" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">
                ニックネーム（表示名）
              </label>
              <input
                id="player-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-4 py-3 bg-slate-50 rounded-xl border border-slate-200 focus:border-blue-500 focus:bg-white outline-none font-bold text-sm transition-all"
                placeholder="例: たなか"
                maxLength={80}
                required
                disabled={isSubmitting}
              />
              <p className="text-[9px] text-slate-400 mt-1 ml-1 font-medium">
                ※{getUtf8ByteLength(name.trim())} / 80バイト（日本語約26文字まで）
              </p>
            </div>

            {/* チーム選択 */}
            <div className="mb-6">
              <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">
                所属チームを選択
              </span>
              <div className="grid grid-cols-2 gap-3">
                {(['A', 'B'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTeam(t)}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-2xl border-2 transition-all ${
                      team === t
                        ? t === 'A'
                          ? 'border-red-500 bg-red-50 text-red-600 scale-[1.02] shadow-sm'
                          : 'border-blue-500 bg-blue-50 text-blue-600 scale-[1.02] shadow-sm'
                        : 'border-slate-100 bg-slate-50 text-slate-300'
                    }`}
                  >
                    <Users size={24} fill={team === t ? 'currentColor' : 'none'} />
                    <span className="font-black text-base tracking-tight">TEAM {t}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 同意チェックボックス（位置情報・削除方針・安全ルール） */}
            <div className="mb-5 space-y-2.5 rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-left">
              <label className="flex items-start gap-2.5 text-[11px] font-bold leading-snug text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentLocationPrivacy}
                  onChange={e => setConsentLocationPrivacy(e.target.checked)}
                  disabled={isSubmitting}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  required
                />
                <span>
                  ゲーム参加中の位置情報（GPS）の利用・チーム／運営への共有範囲、および 48時間後の自動削除ポリシー（TTL）に同意します。
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-[11px] font-bold leading-snug text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentSafetyRules}
                  onChange={e => setConsentSafetyRules(e.target.checked)}
                  disabled={isSubmitting}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  required
                />
                <span>
                  駅構内・ホームでの走行禁止、駆け込み乗車禁止、歩きスマホ禁止、および緊急時の119/110優先などの安全ルールを遵守します。
                </span>
              </label>
            </div>

            <button
              type="submit"
              disabled={
                !joinCode.trim()
                || !userId.trim()
                || !password.trim()
                || !name.trim()
                || !consentLocationPrivacy
                || !consentSafetyRules
                || isSubmitting
              }
              className={`w-full py-4 font-black rounded-xl transition-all shadow-lg uppercase tracking-wider text-sm active:scale-95 flex items-center justify-center gap-2 ${
                isSubmitting || !consentLocationPrivacy || !consentSafetyRules
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-slate-900 hover:bg-black text-white'
              }`}
            >
              <UserCheck size={18} />
              {isSubmitting ? '登録中...' : 'ゲームに参加する'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin}>
            <div className="mb-4">
              <label htmlFor="login-user-id" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">
                ユーザーID
              </label>
              <input
                id="login-user-id"
                type="text"
                value={userId}
                onChange={e => setUserId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                className="w-full px-4 py-3 bg-slate-50 rounded-xl border border-slate-200 focus:border-blue-500 focus:bg-white outline-none font-bold text-sm transition-all"
                placeholder="登録したユーザーID"
                required
                disabled={isSubmitting}
              />
            </div>

            <div className="mb-6">
              <label htmlFor="login-password" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">
                パスワード
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-slate-50 rounded-xl border border-slate-200 focus:border-blue-500 focus:bg-white outline-none font-bold text-sm transition-all"
                placeholder="パスワード"
                required
                disabled={isSubmitting}
              />
            </div>

            <button
              type="submit"
              disabled={!userId.trim() || !password.trim() || isSubmitting}
              className={`w-full py-4 font-black rounded-xl transition-all shadow-lg uppercase tracking-wider text-sm active:scale-95 flex items-center justify-center gap-2 ${
                isSubmitting
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              <LogIn size={18} />
              {isSubmitting ? 'ログイン中...' : 'ログインしてゲームに復帰'}
            </button>
          </form>
        )}

        {isAuthenticated && !gameSessionId && (
          <p className="mt-4 text-center text-xs font-bold text-amber-600 bg-amber-50 p-2.5 rounded-xl border border-amber-200">
            ⏳ ゲームセッション初期化待ちです。<br />管理者が初期化すると参加可能になります。
          </p>
        )}

        {/* 管理者ログインリンク */}
        <div className="mt-6 pt-4 border-t border-slate-100 text-center">
          <Link
            to="/admin"
            className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors py-1 px-3 rounded-lg hover:bg-slate-50"
          >
            <Shield size={14} className="text-slate-400" />
            管理者画面はこちら
          </Link>
        </div>
      </div>

      <footer className="mt-8 text-center">
        <p className="text-slate-500 text-[10px] font-black uppercase tracking-[0.3em] opacity-40">
          Transit Tag Game
        </p>
      </footer>
      </div>
    </div>
  );
};

export default SetupView;