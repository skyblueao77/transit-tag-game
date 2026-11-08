import { calculateHaversineDistanceMeters, type Coordinates } from './locationThrottling.ts';

export interface StationData {
  id: string;
  name: string;
  kana?: string;
  lat: number;
  lng: number;
  pref?: number;
  lines: string[];
}

export type StationProximity = 'AT_STATION' | 'NEAR_STATION' | 'FAR';

export interface StationSuggestion {
  station: StationData;
  distanceMeters: number;
  proximity: StationProximity;
  displayText: string;
  formattedDistance: string;
}

export interface SuggestStationOptions {
  /** Maximum distance to consider a station as a suggestion (default: 5000m) */
  maxDistanceMeters?: number;
  /** Distance threshold within which user is considered at the station / platform (default: 300m) */
  atStationThresholdMeters?: number;
  /** Distance threshold within which user is considered near the station (default: 1500m) */
  nearStationThresholdMeters?: number;
}

const DEFAULT_MAX_DISTANCE_METERS = 5000;
const DEFAULT_AT_STATION_THRESHOLD_METERS = 300;
const DEFAULT_NEAR_STATION_THRESHOLD_METERS = 1500;

/**
 * Formats station name and lines into a user-friendly label.
 * E.g. "東京 (JR山手線 / 東海道新幹線 他)"
 */
export function formatStationLabel(station: StationData): string {
  if (!station.lines || station.lines.length === 0) {
    return station.name;
  }
  if (station.lines.length === 1) {
    return `${station.name} (${station.lines[0]})`;
  }
  if (station.lines.length === 2) {
    return `${station.name} (${station.lines[0]} / ${station.lines[1]})`;
  }
  return `${station.name} (${station.lines[0]} / ${station.lines[1]} 他)`;
}

/**
 * Formats distance into a human-readable Japanese string (e.g. "約80m", "約1.2km").
 */
export function formatDistanceMeters(distanceMeters: number): string {
  if (distanceMeters < 1000) {
    const rounded = Math.max(10, Math.round(distanceMeters / 10) * 10);
    return `約${rounded}m`;
  }
  const km = (distanceMeters / 1000).toFixed(1);
  return `約${km}km`;
}

/**
 * Finds candidate stations within a given radius sorted by distance.
 */
export function findCandidateStations(
  coords: Coordinates,
  stations: StationData[],
  limit = 5,
  options?: SuggestStationOptions,
): StationSuggestion[] {
  if (!coords || !Array.isArray(stations) || stations.length === 0) {
    return [];
  }

  const maxDistance = options?.maxDistanceMeters ?? DEFAULT_MAX_DISTANCE_METERS;
  const atThreshold = options?.atStationThresholdMeters ?? DEFAULT_AT_STATION_THRESHOLD_METERS;
  const nearThreshold = options?.nearStationThresholdMeters ?? DEFAULT_NEAR_STATION_THRESHOLD_METERS;

  // Approximate degree bounding box for fast pre-filtering (~10km box)
  const degBox = (maxDistance / 111000) * 1.5;
  const minLat = coords.latitude - degBox;
  const maxLat = coords.latitude + degBox;
  const minLng = coords.longitude - degBox;
  const maxLng = coords.longitude + degBox;

  const candidates: { station: StationData; distanceMeters: number }[] = [];

  for (const station of stations) {
    if (
      station.lat < minLat ||
      station.lat > maxLat ||
      station.lng < minLng ||
      station.lng > maxLng
    ) {
      continue;
    }

    const dist = calculateHaversineDistanceMeters(coords, {
      latitude: station.lat,
      longitude: station.lng,
    });

    if (dist <= maxDistance) {
      candidates.push({ station, distanceMeters: Math.round(dist) });
    }
  }

  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);

  return candidates.slice(0, limit).map(({ station, distanceMeters }) => {
    let proximity: StationProximity = 'FAR';
    if (distanceMeters <= atThreshold) {
      proximity = 'AT_STATION';
    } else if (distanceMeters <= nearThreshold) {
      proximity = 'NEAR_STATION';
    }

    return {
      station,
      distanceMeters,
      proximity,
      displayText: formatStationLabel(station),
      formattedDistance: formatDistanceMeters(distanceMeters),
    };
  });
}

/**
 * Finds the single best nearest station suggestion.
 */
export function findNearestStation(
  coords: Coordinates,
  stations: StationData[],
  options?: SuggestStationOptions,
): StationSuggestion | null {
  const candidates = findCandidateStations(coords, stations, 1, options);
  return candidates[0] ?? null;
}
