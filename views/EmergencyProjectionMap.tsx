import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EmergencyLocationProjection, User } from '../types';
import L from '../src/lib/leafletSetup';
import { createPlayerMapPopup } from './playerMapPopup';

interface Props {
  projections: EmergencyLocationProjection[];
  users: User[];
}

const EmergencyProjectionMap: React.FC<Props> = ({ projections, users }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [now, setNow] = useState(Date.now());

  const activeProjections = useMemo(
    () => projections.filter(projection => projection.safetyStatus === 'EMERGENCY' && projection.expiresAt > now),
    [projections, now],
  );
  const usersById = useMemo(() => new Map(users.map(user => [user.id, user])), [users]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current).setView([35.6812, 139.7671], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    mapRef.current = map;
    markerLayerRef.current = L.layerGroup().addTo(map);
    setMapReady(true);

    return () => {
      map.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!mapReady || !map || !layer) return;

    layer.clearLayers();
    activeProjections.forEach(projection => {
      const user = usersById.get(projection.playerId);
      const marker = L.circleMarker([projection.latitude, projection.longitude], {
        radius: 10,
        fillColor: '#ef4444',
        color: '#111827',
        weight: 4,
        opacity: 1,
        fillOpacity: 0.9,
      }).addTo(layer);
      if (user) {
        marker.bindPopup(createPlayerMapPopup(document, {
          name: user.name,
          team: user.team,
          status: 'EMERGENCY',
        }, 'EMERGENCY'));
      }
    });
    if (activeProjections.length > 0) {
      const first = activeProjections[0];
      map.setView([first.latitude, first.longitude], Math.max(map.getZoom(), 13));
    }
  }, [mapReady, activeProjections, usersById]);

  return (
    <section className="rounded-3xl border border-red-200 bg-white p-6 shadow-sm">
      <h3 className="mb-2 font-black text-red-700">Emergency locations (Admin only)</h3>
      <p className="mb-4 text-xs text-slate-600">
        SOS時の正確な位置です。位置更新から2分で表示期限が切れます。
      </p>
      <div ref={containerRef} className="h-72 w-full overflow-hidden rounded-2xl bg-slate-100" />
      {activeProjections.length === 0 && (
        <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">有効なEmergency位置はありません。</p>
      )}
      {activeProjections.length > 0 && (
        <ul className="mt-4 space-y-2">
          {activeProjections.map(projection => {
            const user = usersById.get(projection.playerId);
            const remainingSeconds = Math.max(0, Math.ceil((projection.expiresAt - now) / 1000));
            return (
              <li key={projection.playerId} className="flex justify-between gap-3 text-sm">
                <span className="font-bold text-slate-800">
                  {user ? `${user.name} (Team ${user.team})` : 'Emergency player'}
                </span>
                <span className="shrink-0 text-slate-500">期限 {remainingSeconds}秒</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default EmergencyProjectionMap;
