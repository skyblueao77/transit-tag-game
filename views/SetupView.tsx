import type React from 'react';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import type { User } from '../types';
import { TEAM_COLORS } from '../constants';
import { Users, Train, MapPin, Shield, LogIn, UserPlus, UserCheck } from 'lucide-react';
import { registerWithUserId, signInWithUserId } from '../src/infrastructure/firebase/auth';
import { createPlayerWithPrivateLocation } from '../src/infrastructure/firebase/playerStore';
import { db } from '../src/infrastructure/firebase/firebaseClient';

interface Props {
  onComplete: (user: User) => void;
  gameSessionId?: string;
}

const SetupView: React.FC<Props> = ({ onComplete, gameSessionId }) => {
  const [mode, setMode] = useState<'REGISTER' | 'LOGIN'>('REGISTER');
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [team, setTeam] = useState<'A' | 'B'>('A');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [currentPos, setCurrentPos] = useState<{ lat: number; lng: number }>({ lat: 35.6812, lng: 139.7671 });

  const DEFAULT_LAT = 35.6812;
  const DEFAULT_LNG = 139.7671;

  // 起動時に一度だけ現在地を取得
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      pos => {
        setCurrentPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      err => console.log('初期位置取得スキップ:', err.message),
      { enableHighAccuracy: true }
    );
  }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim() || !password.trim() || !name.trim() || isSubmitting) return;
    if (!gameSessionId) {
      alert('ゲームセッション初期化待ちです。管理者が初期化した後に参加してください。');
      return;
    }
    if (password.length < 6) {
      alert('パスワードは6文字以上で入力してください。');
      return;
    }

    setIsSubmitting(true);
    try {
      const id = await registerWithUserId(userId, password);
      const color: string = team === 'A' ? TEAM_COLORS[0] : TEAM_COLORS[1];

      const newUser: User = {
        id,
        name: name.trim(),
        role: 'RUNNER',
        team,
        color,
        score: 0,
        status: 'ACTIVE',
        gameSessionId,
        invincibleCards: 0,
      };

      await createPlayerWithPrivateLocation(newUser, {
        latitude: currentPos.lat,
        longitude: currentPos.lng,
      }, gameSessionId);

      onComplete(newUser);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/email-already-in-use') {
        alert('このユーザーIDは既に登録されています。「ログイン」タブからログインするか、別のIDを入力してください。');
      } else if (code === 'auth/weak-password') {
        alert('パスワードは6文字以上で入力してください。');
      } else {
        console.error('Registration error:', err);
        alert('登録に失敗しました。通信環境や入力内容をご確認ください。');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim() || !password.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const uid = await signInWithUserId(userId, password);
      const userSnap = await getDoc(doc(db, 'users', uid));

      if (userSnap.exists()) {
        const existingUser = userSnap.data() as User;
        const targetSession = gameSessionId || existingUser.gameSessionId || '';
        await createPlayerWithPrivateLocation(existingUser, {
          latitude: currentPos.lat,
          longitude: currentPos.lng,
        }, targetSession);
        onComplete(existingUser);
      } else {
        alert('プレイヤー情報が見つかりません。「新規参加」タブからアカウントを作成してください。');
      }
    } catch (err: unknown) {
      console.error('Login error:', err);
      alert('ログインに失敗しました。ユーザーIDとパスワードをご確認ください。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isLocationReady =
    currentPos.lat !== DEFAULT_LAT || currentPos.lng !== DEFAULT_LNG;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-4 py-8 flex flex-col justify-center items-center text-white font-sans">
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

      <div className="w-full max-w-sm bg-white rounded-[2.5rem] p-7 shadow-[0_20px_50px_rgba(0,0,0,0.3)] text-slate-800 overflow-hidden relative">
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
                maxLength={50}
                required
                disabled={isSubmitting}
              />
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

            <button
              type="submit"
              disabled={!userId.trim() || !password.trim() || !name.trim() || isSubmitting || !gameSessionId}
              className={`w-full py-4 font-black rounded-xl transition-all shadow-lg uppercase tracking-wider text-sm active:scale-95 flex items-center justify-center gap-2 ${
                isSubmitting || !gameSessionId
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

        {!gameSessionId && (
          <p className="mt-4 text-center text-xs font-bold text-amber-600 bg-amber-50 p-2.5 rounded-xl border border-amber-200">
            ⏳ ゲームセッション初期化待ちです。<br />管理者が初期化すると参加可能になります。
          </p>
        )}

        {isLocationReady && (
          <div className="mt-4 flex items-center justify-center gap-1 text-[9px] font-bold text-emerald-600 uppercase tracking-tighter">
            <MapPin size={11} /> GPS測位準備完了
          </div>
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
  );
};

export default SetupView;