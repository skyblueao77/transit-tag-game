import React, { useState, useEffect } from 'react';
import { User } from '../types';
import { TEAM_COLORS } from '../constants';
import { Users, Train, MapPin } from 'lucide-react';
import { auth, db } from '../firebase';
import { signInAnonymously } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';

interface Props {
  onComplete: (user: User) => void;
}

const SetupView: React.FC<Props> = ({ onComplete }) => {
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


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      if (!auth.currentUser) await signInAnonymously(auth);
    } catch (error) {
      console.error('Anonymous authentication failed:', error);
      alert('認証に失敗しました。Firebase Authenticationの匿名ログインを有効にしてください。');
      setIsSubmitting(false);
      return;
    }

    const id = auth.currentUser?.uid;
    if (!id) {
      alert('認証ユーザーを取得できませんでした。');
      setIsSubmitting(false);
      return;
    }
    // TEAM_COLORS[0] → Team A、TEAM_COLORS[1] → Team B に対応
    const color: string = team === 'A' ? TEAM_COLORS[0] : TEAM_COLORS[1];

    const newUser: User = {
      id,
      name,
      role: 'RUNNER',
      team,
      color,
      score: 0,
      lastLat: currentPos.lat,
      lastLng: currentPos.lng,
      lastUpdate: Date.now(),
      status: 'ACTIVE',
      invincibleCards: 0,
    };

    try {
      await setDoc(doc(db, 'users', id), newUser);
      localStorage.setItem('kyun_user', JSON.stringify(newUser));
      onComplete(newUser);
    } catch (error) {
      console.error('Error saving user:', error);
      alert('接続エラー：インターネット環境を確認してください。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isLocationReady =
    currentPos.lat !== DEFAULT_LAT || currentPos.lng !== DEFAULT_LNG;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-6 flex flex-col justify-center items-center text-white">
      <div className="mb-10 text-center animate-in fade-in zoom-in duration-700">
        <div

          className="w-24 h-24 bg-white/5 backdrop-blur-xl rounded-[2.5rem] flex items-center justify-center mx-auto mb-6 shadow-2xl active:scale-90 transition-all cursor-pointer border border-white/10"
        >
          <Train size={48} className="text-blue-400 drop-shadow-[0_0_15px_rgba(96,165,250,0.5)]" />
        </div>
        <h1 className="text-4xl font-black italic tracking-tighter mb-2 uppercase bg-clip-text text-transparent bg-gradient-to-b from-white to-slate-400">
          Kyun Tag
        </h1>
        <div className="flex items-center justify-center gap-2 text-blue-400/60 font-black text-[10px] tracking-[0.3em] uppercase">
          <span className="w-8 h-[1px] bg-blue-400/20"></span>
          Team Battle Mode
          <span className="w-8 h-[1px] bg-blue-400/20"></span>
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white rounded-[2.5rem] p-10 shadow-[0_20px_50px_rgba(0,0,0,0.3)] text-slate-800 overflow-hidden relative"
      >
        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-red-500 via-white to-blue-500 opacity-50"></div>

        {/* プレイヤー名 */}
        <div className="mb-8">
          <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-3 ml-1">
            Player Name
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full px-6 py-5 bg-slate-50 rounded-2xl border-2 border-slate-100 focus:border-blue-500 focus:bg-white outline-none font-bold text-lg transition-all"
            placeholder="ニックネーム"
            required
            disabled={isSubmitting}
          />
        </div>

        {/* チーム選択 */}
        <div className="mb-10">
          <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-4 ml-1">
            Select Team
          </label>
          <div className="grid grid-cols-2 gap-4">
            {(['A', 'B'] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTeam(t)}
                className={`flex flex-col items-center gap-3 p-5 rounded-3xl border-4 transition-all duration-300 ${
                  team === t
                    ? t === 'A'
                      ? 'border-red-500 bg-red-50 text-red-600 scale-105 shadow-lg shadow-red-100'
                      : 'border-blue-500 bg-blue-50 text-blue-600 scale-105 shadow-lg shadow-blue-100'
                    : 'border-slate-50 bg-slate-50 text-slate-300 opacity-60'
                }`}
              >
                <Users size={36} fill={team === t ? 'currentColor' : 'none'} />
                <span className="font-black text-xl tracking-tighter italic">TEAM {t}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 送信ボタン */}
        <button
          type="submit"
          disabled={!name.trim() || isSubmitting}
          className={`w-full py-6 font-black rounded-2xl transition-all shadow-2xl uppercase tracking-[0.2em] text-lg active:scale-95 ${
            isSubmitting
              ? 'bg-slate-200 text-slate-400'
              : 'bg-slate-950 hover:bg-black text-white shadow-slate-300'
          }`}
        >
          {isSubmitting ? 'Joining...' : 'Entry Game'}
        </button>

        {/* 位置情報取得済みインジケーター */}
        {isLocationReady && (
          <div className="mt-6 flex items-center justify-center gap-1 text-[9px] font-bold text-emerald-500 uppercase tracking-tighter animate-pulse">
            <MapPin size={10} /> Location Ready
          </div>
        )}
      </form>

      <footer className="mt-12 text-center">
        <p className="text-slate-500 text-[10px] font-black uppercase tracking-[0.4em] opacity-50">
          Open Transit Game Project
        </p>
      </footer>
    </div>
  );
};

export default SetupView;