import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EmergencyLocationProjection, User } from '../types';
import L from '../src/lib/leafletSetup';
import { createPlayerMapPopup } from './playerMapPopup';
import { getServerNowMs } from '../src/infrastructure/firebase/serverClock';

interface Props {
  projections: EmergencyLocationProjection[];
  users: User[];
}

const EmergencyProjectionList: React.FC<{
  activeProjections: EmergencyLocationProjection[];
  usersById: Map<string, User>;
}> = ({ activeProjections, usersById }) => {
  const [now, setNow] = useState(() => getServerNowMs());

  useEffect(() => {
    if (activeProjections.length === 0) return;
    setNow(getServerNowMs());
    const timer = window.setInterval(() => setNow(getServerNowMs()), 1000);
    return () => window.clearInterval(timer);
  }, [activeProjections.length]);

  if (activeProjections.length === 0) {
    return <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">有効なEmergency位置はありません。</p>;
  }

  return (
    <ul className="mt-4 space-y-2">
      {activeProjections.map(projection => {
        const user = usersById.get(projection.playerId);
        const remainingSeconds = Math.max(0, Math.ceil((projection.expiresAt - now) / 1000));
        const isStale = projection.expiresAt <= now;
        const elapsedMinutes = Math.max(1, Math.floor((now - projection.projectedAt) / 60_000));
        return (
          <li key={projection.playerId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-bold text-slate-800">
              {user ? `${user.name} (Team ${user.team})` : 'Emergency player'}
            </span>
            {isStale ? (
              <span className="shrink-0 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
                最終更新: {elapsedMinutes}分前（通信途絶の可能性）
              </span>
            ) : (
              <span className="shrink-0 text-xs font-bold text-emerald-700">
                最新（あと{remainingSeconds}秒）
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
};

const EmergencyProjectionMap: React.FC<Props> = ({ projections, users }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Record<string, L.CircleMarker>>({});
  const hasAutoCenteredRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);

  const usersById = useMemo(() => new Map(users.map(user => [user.id, user])), [users]);
  const activeProjections = useMemo(
    () => projections.filter(projection => {
      if (projection.safetyStatus !== 'EMERGENCY') return false;
      const user = usersById.get(projection.playerId);
      return user ? user.status === 'EMERGENCY' : true;
    }),
    [projections, usersById],
  );

  // Track staleness state only at coarse intervals / transition points rather than re-rendering the map every 1s
  const [staleEpochMs, setStaleEpochMs] = useState(() => getServerNowMs());
  useEffect(() => {
    if (activeProjections.length === 0) return;
    setStaleEpochMs(getServerNowMs());
    const timer = window.setInterval(() => setStaleEpochMs(getServerNowMs()), 5000);
    return () => window.clearInterval(timer);
  }, [activeProjections.length]);

  const staleSignature = useMemo(
    () => activeProjections.map(p => `${p.playerId}:${p.expiresAt <= staleEpochMs ? 1 : 0}`).join('|'),
    [activeProjections, staleEpochMs],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current).setView([35.6812, 139.7671], 11);
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>',
      crossOrigin: true,
      maxZoom: 18,
    }).addTo(map);
    mapRef.current = map;
    markerLayerRef.current = L.layerGroup().addTo(map);
    setMapReady(true);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        map.invalidateSize({ pan: false });
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      markersRef.current = {};
      hasAutoCenteredRef.current = false;
      setMapReady(false);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: staleSignature already captures staleness transitions from staleEpochMs
  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!mapReady || !map || !layer) return;

    const currentNow = getServerNowMs();
    const nextIds = new Set(activeProjections.map(projection => projection.playerId));

    for (const [id, marker] of Object.entries(markersRef.current)) {
      if (!nextIds.has(id)) {
        layer.removeLayer(marker);
        delete markersRef.current[id];
      }
    }

    activeProjections.forEach(projection => {
      const user = usersById.get(projection.playerId);
      const isStale = projection.expiresAt <= currentNow;
      const popupContent = user
        ? createPlayerMapPopup(document, {
            name: user.name,
            team: user.team,
            status: 'EMERGENCY',
          }, 'EMERGENCY')
        : null;

      const markerStyle: L.CircleMarkerOptions = {
        radius: 10,
        fillColor: isStale ? '#f97316' : '#ef4444',
        color: '#111827',
        weight: 4,
        opacity: 1,
        fillOpacity: isStale ? 0.65 : 0.9,
      };

      const existingMarker = markersRef.current[projection.playerId];
      if (existingMarker) {
        existingMarker.setLatLng([projection.latitude, projection.longitude]);
        existingMarker.setStyle(markerStyle);
        if (popupContent) {
          if (existingMarker.getPopup()) {
            existingMarker.setPopupContent(popupContent);
          } else {
            existingMarker.bindPopup(popupContent);
          }
        } else if (existingMarker.getPopup()) {
          existingMarker.unbindPopup();
        }
        return;
      }

      const marker = L.circleMarker([projection.latitude, projection.longitude], markerStyle).addTo(layer);
      if (popupContent) {
        marker.bindPopup(popupContent);
      }
      markersRef.current[projection.playerId] = marker;
    });

    if (activeProjections.length === 0) {
      hasAutoCenteredRef.current = false;
    } else if (!hasAutoCenteredRef.current) {
      const first = activeProjections[0];
      map.setView([first.latitude, first.longitude], Math.max(map.getZoom(), 13));
      hasAutoCenteredRef.current = true;
    }
  }, [mapReady, activeProjections, usersById, staleSignature]);

  return (
    <section className="rounded-3xl border border-red-200 bg-white p-6 shadow-sm">
      <h3 className="mb-2 font-black text-red-700">Emergency locations (Admin only)</h3>
      <p className="mb-4 text-xs text-slate-600">
        SOS時の正確な位置です。2分以上更新が途絶えた場合も、管理者が解除するまで最終位置を保持します。
      </p>
      <div ref={containerRef} className="h-72 lg:h-96 w-full overflow-hidden rounded-2xl bg-slate-100" />
      <EmergencyProjectionList activeProjections={activeProjections} usersById={usersById} />
    </section>
  );
};

export default EmergencyProjectionMap;
