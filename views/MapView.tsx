import React, { useEffect, useRef, useState, useCallback } from 'react';
import { User, LocationLog, GameConfig, Role } from '../types';
import { getPlayerRole, isGamePaused } from '../src/game';
import { Shield, Clock, Zap, Train, MapPin, AlertCircle, Lock, WifiOff } from 'lucide-react';
import { doc, updateDoc, setDoc, FieldValue, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';



interface Props {
  users: User[];
  logs: LocationLog[];
  currentUser: User;
  gameConfig: GameConfig;
  onCapture: (runnerId: string) => Promise<void>;
  onActivateInvincibility: () => Promise<void>;
  onStartShinkansenWait: () => Promise<void>;
}

const MapView: React.FC<Props> = ({
  users, currentUser, gameConfig, onCapture, onActivateInvincibility, onStartShinkansenWait
}) => {
  const mapRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<Record<string, any>>({});
  const [timeLeft, setTimeLeft] = useState({
    waiting: 0, invincible: 0, nextReveal: 0, final: 0, oniLock: 0, shinkansenRemaining: 0, forceReveal: 0, teamSearchRemaining: 0 // ← これを追加
  });
  const [isLeafletReady, setIsLeafletReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const watchId = useRef<number | null>(null);
  const lastUploadTime = useRef<number>(0);

  const currentRole: Role = getPlayerRole(currentUser, gameConfig);

  // Leaflet 読み込み確認
  useEffect(() => {
    const check = () => { if ((window as any).L) setIsLeafletReady(true); else setTimeout(check, 100); };
    check();
  }, []);

  // オンライン状態監視
  useEffect(() => {
    const on = () => setIsOffline(false);
    const off = () => setIsOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // 位置情報更新
  const updateLocation = useCallback(async (position: GeolocationPosition) => {
    if (!currentUser || isGamePaused(gameConfig.gameStatus)) return;
    if (!navigator.onLine) return;

    const now = Date.now();
    if (now - lastUploadTime.current < 60000) return;
    if (position.coords.accuracy > 400) return;

    try {
      await setDoc(doc(db, 'users', currentUser.id), {
        lastLat: position.coords.latitude,
        lastLng: position.coords.longitude,
        lastUpdate: serverTimestamp() as FieldValue,
      }, { merge: true });
      lastUploadTime.current = now;
    } catch (error) {
      console.error('Failed to update location:', error);
    }
  }, [currentUser, gameConfig.gameStatus]);

  // watchPosition
  useEffect(() => {
    if (!currentUser || !('geolocation' in navigator)) return;
    if (watchId.current) navigator.geolocation.clearWatch(watchId.current);

    watchId.current = navigator.geolocation.watchPosition(
      position => {
        const latDiff = Math.abs(position.coords.latitude - (currentUser.lastLat || 0));
        const lngDiff = Math.abs(position.coords.longitude - (currentUser.lastLng || 0));
        if (latDiff > 0.0001 || lngDiff > 0.0001) updateLocation(position);
      },
      error => console.error('Geolocation watch error:', error),
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 }
    );

    return () => {
      if (watchId.current) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
    };
  }, [currentUser, updateLocation]);

  // タイマー
  useEffect(() => {
    const timer = setInterval(() => {
      if (isGamePaused(gameConfig.gameStatus)) return;
      const now = Date.now();

      // 管理者強制開示の残り時間を計算
      const forceReveal = gameConfig.locationRevealUntil 
        ? Math.max(0, Math.floor((gameConfig.locationRevealUntil - now) / 1000)) 
        : 0;

      const myTeamRevealUntil = currentUser.team === 'A' 
    ? (gameConfig.teamARevealUntil || 0) 
    : (gameConfig.teamBRevealUntil || 0);
      const teamSearchRemaining = Math.max(0, Math.floor((myTeamRevealUntil - now) / 1000));
      const waiting = currentUser.waitingUntil ? Math.max(0, Math.floor((currentUser.waitingUntil - now) / 1000)) : 0;
      const invincible = currentUser.invincibleUntil ? Math.max(0, Math.floor((currentUser.invincibleUntil - now) / 1000)) : 0;
      //const nextReveal = Math.max(0, Math.floor(((gameConfig.nextRevealTime ?? now) - now) / 1000));
      const final = gameConfig.isFinalMissionActive ? Math.max(0, Math.floor((gameConfig.finalMissionEndTime - now) / 1000)) : 0;
      
      
      const oniLockTime = (gameConfig.startTime || 0) + 30 * 60 * 1000;
      const oniLock = currentRole === 'ONI' ? Math.max(0, Math.floor((oniLockTime - now) / 1000)) : 0;
      const nextReveal = gameConfig.nextRevealTime
        ? Math.max(0, Math.floor((gameConfig.nextRevealTime - now) / 1000))
        : 0;


      const shinkansenRemaining = currentUser.shinkansenStartTime
        ? Math.max(0, Math.floor((currentUser.shinkansenStartTime + 2.5 * 60 * 60 * 1000 - now) / 1000))
        : 0;
      
      setTimeLeft({ waiting, invincible, nextReveal, final, oniLock, shinkansenRemaining, forceReveal,teamSearchRemaining });
    }, 1000);
    return () => clearInterval(timer);
  }, [currentUser, gameConfig, currentRole]);

  // 地図初期化
  useEffect(() => {
    if (!containerRef.current || !isLeafletReady || timeLeft.oniLock > 0) return;
    const L = (window as any).L;
    if (!mapRef.current) {
      mapRef.current = L.map(containerRef.current).setView(
        [currentUser.lastLat || 35.6812, currentUser.lastLng || 139.7671], 13
      );
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(mapRef.current);
    } else {
      mapRef.current.setView([currentUser.lastLat || 35.6812, currentUser.lastLng || 139.7671], 13);
    }
  }, [isLeafletReady, timeLeft.oniLock, currentUser.lastLat, currentUser.lastLng]);

// ── マーカー描画（強制共有・チーム別サーチ対応版） ────────────────────────
  useEffect(() => {
    const L = (window as any).L;
    if (!mapRef.current || !L) return;

    // 既存マーカーを全削除
    Object.values(markersRef.current).forEach((m: any) => m.remove());
    markersRef.current = {};

    const now = Date.now();
    
    // 全体強制開示（管理者ボタン）の状態
    const isGlobalForceReveal = (gameConfig.locationRevealUntil || 0) > now;

users.forEach(user => {
      const isSelf = user.id === currentUser.id;
      const isEmergency = user.status === 'EMERGENCY' || user.status === 'RETIRED';

      // 1. 自分自身の表示
      if (isSelf) {
        if (!user.lastLat || !user.lastLng) return;
        const marker = L.circleMarker([user.lastLat, user.lastLng], {
          radius: 10, fillColor: user.color, color: '#fff', weight: 3, opacity: 1, fillOpacity: 0.95,
        }).addTo(mapRef.current);
        marker.bindPopup(`<b>【自分】${user.name} (Team ${user.team})</b><br/>現在地`);
        markersRef.current[user.id] = marker;
        return;
      }

      // 2. 緊急状態の表示
      if (isEmergency) {
        if (!user.lastLat || !user.lastLng) return;
        const marker = L.circleMarker([user.lastLat, user.lastLng], {
          radius: 10, fillColor: '#ef4444', color: '#000', weight: 5, opacity: 1, fillOpacity: 0.9,
        }).addTo(mapRef.current);
        marker.bindPopup(`<b style="color:red">【緊急:${user.status}】${user.name}</b>`);
        marker.openPopup();
        markersRef.current[user.id] = marker;
        return;
      }

      // 3. 表示判定ロジック
      
      // A. チーム別サーチ（ペナルティ）中か？
      const teamRevealUntil = user.team === 'A' 
        ? (gameConfig.teamARevealUntil || 0) 
        : (gameConfig.teamBRevealUntil || 0);
      const isTeamSearchActive = teamRevealUntil > now;

      
      // C. 個人のミッション完了によるスナップショット公開中か？
      const isIndividualExposed =
        user.locationExposedUntil != null &&
        user.locationExposedUntil > now &&
        user.exposedLat != null &&
        user.exposedLng != null;

      // いずれかの条件を満たしていれば表示
      if (!isGlobalForceReveal && !isTeamSearchActive && !isIndividualExposed) return;

      // 4. 座標の決定
      // 🚨 チーム個別サーチ（ペナルティ）の時だけ「リアルタイム（最新地）」を使う
      // 📸 それ以外の公開（一斉公開・個人公開）は「スナップショット（固定値）」を使う
      const displayLat = isTeamSearchActive ? user.lastLat : user.exposedLat!;
      const displayLng = isTeamSearchActive ? user.lastLng : user.exposedLng!;

      if (!displayLat || !displayLng) return;

      const isInvincible = user.invincibleUntil && user.invincibleUntil > now;

      // 5. マーカーのスタイル
      const marker = L.circleMarker([displayLat, displayLng], {
        radius: 8,
        // 色分け：チームサーチは赤、一斉スナップショットはオレンジ、個人はチーム色
        fillColor: isTeamSearchActive ? '#ef4444' : (isGlobalForceReveal ? '#f59e0b' : user.color),
        color: isInvincible ? '#fbbf24' : '#fff',
        weight: isInvincible ? 4 : 3,
        opacity: 1,
        fillOpacity: isTeamSearchActive ? 0.9 : 0.7,
      }).addTo(mapRef.current);
      
      
      // 6. ポップアップ内容
      let popupContent = `<b>${user.name} (Team ${user.team})</b><br/>`;
      if (isTeamSearchActive) {
        popupContent += `<span style="color:red; font-weight:bold;">🚨 チーム個別サーチ中 (リアルタイム)</span>`;
      } else if (isGlobalForceReveal) {
        popupContent += `<span style="color:orange; font-weight:bold;">📸 全員スナップショット公開中</span>`;
      } else {
        const remainSec = Math.floor(((user.locationExposedUntil as number) - now) / 1000);
        popupContent += `<small>📍 公開中の位置 (残り ${formatTime(remainSec)})</small>`;
      }

      marker.bindPopup(popupContent);
      markersRef.current[user.id] = marker;
    });
  }, [
    users, 
    currentUser, 
    timeLeft, 
    gameConfig.locationRevealUntil, 
    gameConfig.teamARevealUntil, 
    gameConfig.teamBRevealUntil
  ]); // 依存配列にチーム別の開示期限を追加
  
  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  if (timeLeft.oniLock > 0) {
    return (
      <div className="h-full bg-slate-900 flex flex-col items-center justify-center p-6 text-center text-white">
        <div className="w-24 h-24 bg-red-600/20 rounded-full flex items-center justify-center mb-8 border-4 border-red-600/30 animate-pulse">
          <Lock size={48} className="text-red-500" />
        </div>
        <h2 className="text-3xl font-black mb-2 italic tracking-tighter uppercase">ONI WAITING...</h2>
        <p className="text-slate-400 font-bold mb-12 uppercase tracking-widest text-xs leading-relaxed">
          逃走者の移動開始から30分間は、<br />鬼は待機しなければなりません。
        </p>
        <div className="bg-slate-800 px-10 py-6 rounded-3xl border border-slate-700 shadow-2xl">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Time to Release</div>
          <div className="text-5xl font-black font-mono text-white">{formatTime(timeLeft.oniLock)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      {isOffline && (
        <div className="z-[1002] bg-orange-600 text-white text-[10px] font-black py-1 px-4 flex items-center justify-center gap-2">
          <WifiOff size={12} /> 通信断：位置更新を一時停止中
        </div>
      )}



  {/* ゲームステータスヘッダー */}
  {timeLeft.teamSearchRemaining > 0 ? (
    /* 🚨 チーム別サーチ中（ペナルティ等）の表示：最優先・赤色 */
    <div className="z-[1001] px-4 py-2 bg-red-600 text-white text-center text-xs font-black animate-pulse flex items-center justify-center gap-2">
      <AlertCircle size={14} /> 【警告】現在地が相手にリアルタイム公開中！ 残り {formatTime(timeLeft.teamSearchRemaining)}
    </div>
  ) : timeLeft.forceReveal > 0 ? (
    /* ⚠️ 管理者による全員スナップショット公開中の表示：オレンジ */
    <div className="z-[1001] px-4 py-2 bg-amber-500 text-white text-center text-xs font-black flex items-center justify-center gap-2">
      <MapPin size={14} /> 管理者による位置強制公開中！ 残り {formatTime(timeLeft.forceReveal)}
    </div>

  ) : timeLeft.nextReveal > 0 ? (
    <div className="z-[1001] px-4 py-2 bg-indigo-600 text-white text-center text-xs font-black flex items-center justify-center gap-2">
      <Clock size={14} /> 次の位置公開まで {formatTime(timeLeft.nextReveal)}
    </div>

  ) : gameConfig.isFinalMissionActive ? (
    /* 🏁 最終ミッション中の表示：赤色 */
    <div className="z-[1001] px-4 py-2 bg-slate-900 text-red-500 text-center text-xs font-black animate-pulse flex items-center justify-center gap-2 border-b border-red-500/50">
      <AlertCircle size={14} /> 最終ミッション：東京駅を目指せ！ {Math.floor(timeLeft.final / 60)}分
    </div>
  ) : null}
      <div ref={containerRef} style={{ flex: 1, width: '100%', zIndex: 0 }} />

      <div className="absolute top-16 left-4 z-[1000] flex flex-col gap-2">
        {timeLeft.invincible > 0 && (
          <div className="bg-amber-500 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg">
            無敵中: {formatTime(timeLeft.invincible)}
          </div>
        )}
        {timeLeft.waiting > 0 && (
          <div className="bg-slate-900 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg">
            待機中: {formatTime(timeLeft.waiting)}
          </div>
        )}
        {timeLeft.shinkansenRemaining > 0 && currentUser.status === 'ACTIVE' && (
          <div className="bg-blue-600 text-white px-3 py-1.5 rounded-xl text-[10px] font-black shadow-lg flex items-center gap-1">
            <Train size={12} /> 新幹線移動: {formatTime(timeLeft.shinkansenRemaining)}
          </div>
        )}
      </div>

      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-[1000] w-full px-6 flex flex-col items-center gap-3">
        {currentRole === 'ONI' && (
          <button
            onClick={async () => { setIsProcessing(true); await onCapture(''); setIsProcessing(false); }}
            disabled={isProcessing || currentUser.status === 'WAITING' || gameConfig.gameStatus.includes('_PAUSED')}
            className={`px-10 py-4 rounded-full font-black text-lg shadow-2xl transition-all ${
              isProcessing || currentUser.status === 'WAITING' || gameConfig.gameStatus.includes('_PAUSED')
                ? 'bg-slate-400 text-white'
                : 'bg-slate-900 text-white active:scale-95'
            }`}
          >
            捕獲ボタン
          </button>
        )}
        {currentRole === 'RUNNER' && (
          <div className="flex gap-2">
            <button
              onClick={async () => {
                setIsProcessing(true);
                try { await onActivateInvincibility(); }
                catch { alert('失敗しました'); }
                finally { setIsProcessing(false); }
              }}
              disabled={
                isProcessing || (currentUser.invincibleCards ?? 0) <= 0 || timeLeft.invincible > 0 || gameConfig.gameStatus.includes('_PAUSED')
              }
              className="px-4 py-3 bg-amber-500 text-white rounded-2xl font-bold text-sm shadow-xl disabled:bg-slate-100 disabled:text-slate-400 active:scale-95 transition-all"
            >
              無敵カード ({currentUser.invincibleCards ?? 0})
            </button>
            <button
              onClick={async () => {
                setIsProcessing(true);
                try { await onStartShinkansenWait(); }
                catch { alert('失敗しました'); }
                finally { setIsProcessing(false); }
              }}
              disabled={isProcessing || gameConfig.gameStatus.includes('_PAUSED') || timeLeft.shinkansenRemaining > 0}
              className="px-4 py-3 bg-white text-slate-700 rounded-2xl font-bold text-sm shadow-xl border border-slate-200 disabled:bg-slate-50 active:scale-95 transition-all"
            >
              新幹線待機
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default MapView;

