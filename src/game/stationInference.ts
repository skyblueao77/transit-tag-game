import { calculateHaversineDistanceMeters, type Coordinates } from './locationThrottling.ts';

export interface StationConnection {
  line: string;
  to: string;
}

export interface StationData {
  id: string;
  name: string;
  kana?: string;
  lat: number;
  lng: number;
  pref?: number;
  lines: string[];
  next?: StationConnection[];
}

export type StationProximity = 'AT_STATION' | 'NEAR_STATION' | 'FAR';
export type TransitProximity = 'AT_STATION' | 'IN_TRANSIT' | 'NEAR_STATION' | 'FAR';

export interface StationSuggestion {
  station: StationData;
  distanceMeters: number;
  proximity: StationProximity;
  displayText: string;
  formattedDistance: string;
}

export interface TransitSegment {
  lineName: string;
  stationA: StationData;
  stationB: StationData;
  crossTrackDistanceMeters: number;
  projectionRatio: number;
  headingStation?: StationData;
}

export interface TransitSuggestion {
  type: 'STATION' | 'SEGMENT';
  proximity: TransitProximity;
  station?: StationData;
  segment?: TransitSegment;
  distanceMeters: number;
  displayText: string;
  formattedDistance: string;
  headingStation?: StationData;
}

export interface SuggestStationOptions {
  /** Maximum distance to consider a station as a suggestion (default: 5000m) */
  maxDistanceMeters?: number;
  /** Distance threshold within which user is considered at the station / platform (default: 250m) */
  atStationThresholdMeters?: number;
  /** Distance threshold within which user is considered near the station (default: 1500m) */
  nearStationThresholdMeters?: number;
  /** Distance threshold to track line for in-transit detection (default: 600m) */
  segmentThresholdMeters?: number;
  /** Previous coordinates to infer movement heading / direction (Phase 3) */
  previousCoords?: Coordinates | null;
  /** Minimum movement distance in meters to detect direction (default: 15m) */
  minHeadingMoveMeters?: number;
}

const DEFAULT_MAX_DISTANCE_METERS = 5000;
const DEFAULT_AT_STATION_THRESHOLD_METERS = 250;
const DEFAULT_NEAR_STATION_THRESHOLD_METERS = 1500;
const DEFAULT_SEGMENT_THRESHOLD_METERS = 600;
const DEFAULT_MIN_HEADING_MOVE_METERS = 15;

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
 * Formats segment into a user-friendly Japanese transit label.
 * E.g. "JR山手線 渋谷〜恵比寿間" or "JR山手線 渋谷〜恵比寿間 (次は恵比寿)"
 */
export function formatSegmentLabel(
  lineName: string,
  stationA: StationData,
  stationB: StationData,
  headingStation?: StationData,
): string {
  if (headingStation) {
    const originStation = headingStation.id === stationA.id ? stationB : stationA;
    return `${lineName} ${originStation.name}〜${headingStation.name}間 (次は${headingStation.name})`;
  }
  return `${lineName} ${stationA.name}〜${stationB.name}間`;
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

export interface PointToSegmentResult {
  crossTrackDistanceMeters: number;
  projectionRatio: number;
  isBetween: boolean;
}

/**
 * Computes the perpendicular distance from point P to line segment AB,
 * and determines if P is projected between station A and station B.
 */
export function calculatePointToSegmentDistance(
  point: Coordinates,
  stationA: Coordinates,
  stationB: Coordinates,
): PointToSegmentResult {
  const latMid = (stationA.latitude + stationB.latitude) / 2;
  const latRad = (latMid * Math.PI) / 180;
  const metersPerLngDegree = 111320 * Math.cos(latRad);
  const metersPerLatDegree = 110574;

  const dx = (stationB.longitude - stationA.longitude) * metersPerLngDegree;
  const dy = (stationB.latitude - stationA.latitude) * metersPerLatDegree;
  const lineLengthSq = dx * dx + dy * dy;

  if (lineLengthSq === 0) {
    const dist = calculateHaversineDistanceMeters(point, stationA);
    return {
      crossTrackDistanceMeters: dist,
      projectionRatio: 0,
      isBetween: false,
    };
  }

  const px = (point.longitude - stationA.longitude) * metersPerLngDegree;
  const py = (point.latitude - stationA.latitude) * metersPerLatDegree;

  // Project point onto line segment: t = (P . V) / |V|^2
  const projectionRatio = (px * dx + py * dy) / lineLengthSq;

  let nearestLat: number;
  let nearestLng: number;

  if (projectionRatio <= 0) {
    nearestLat = stationA.latitude;
    nearestLng = stationA.longitude;
  } else if (projectionRatio >= 1) {
    nearestLat = stationB.latitude;
    nearestLng = stationB.longitude;
  } else {
    nearestLat = stationA.latitude + (stationB.latitude - stationA.latitude) * projectionRatio;
    nearestLng = stationA.longitude + (stationB.longitude - stationA.longitude) * projectionRatio;
  }

  const crossTrackDistanceMeters = calculateHaversineDistanceMeters(point, {
    latitude: nearestLat,
    longitude: nearestLng,
  });

  // Considered strictly between stations if ratio is comfortably between endpoints
  const isBetween = projectionRatio >= 0.05 && projectionRatio <= 0.95;

  return {
    crossTrackDistanceMeters,
    projectionRatio,
    isBetween,
  };
}

export interface SegmentHeadingResult {
  headingStation: StationData;
  originStation: StationData;
  alignment: number;
}

/**
 * Phase 3: Infers transit travel direction and next station from movement vector.
 * Uses dot product between movement vector and railway segment vector.
 */
export function inferSegmentHeading(
  currentCoords: Coordinates,
  previousCoords: Coordinates,
  stationA: StationData,
  stationB: StationData,
  minHeadingMoveMeters = DEFAULT_MIN_HEADING_MOVE_METERS,
): SegmentHeadingResult | null {
  if (!currentCoords || !previousCoords || !stationA || !stationB) {
    return null;
  }

  const moveDist = calculateHaversineDistanceMeters(previousCoords, currentCoords);
  if (moveDist < minHeadingMoveMeters) {
    // Insufficient movement to infer directional vector reliably
    return null;
  }

  const latMid = (stationA.lat + stationB.lat) / 2;
  const latRad = (latMid * Math.PI) / 180;
  const metersPerLngDegree = 111320 * Math.cos(latRad);
  const metersPerLatDegree = 110574;

  // Segment vector: A -> B
  const dx = (stationB.lng - stationA.lng) * metersPerLngDegree;
  const dy = (stationB.lat - stationA.lat) * metersPerLatDegree;
  const segLength = Math.sqrt(dx * dx + dy * dy);
  if (segLength === 0) return null;

  // Movement vector: prev -> curr
  const mx = (currentCoords.longitude - previousCoords.longitude) * metersPerLngDegree;
  const my = (currentCoords.latitude - previousCoords.latitude) * metersPerLatDegree;
  const moveLength = Math.sqrt(mx * mx + my * my);
  if (moveLength === 0) return null;

  // Cosine similarity
  const dot = mx * dx + my * dy;
  const alignment = dot / (segLength * moveLength);

  // Require reasonable directional alignment along the railway tracks (abs >= 0.25)
  if (Math.abs(alignment) < 0.25) {
    return null;
  }

  if (alignment > 0) {
    // Heading from Station A towards Station B
    return {
      headingStation: stationB,
      originStation: stationA,
      alignment,
    };
  }

  // Heading from Station B towards Station A
  return {
    headingStation: stationA,
    originStation: stationB,
    alignment,
  };
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
 * Finds the single best nearest station suggestion (Phase 1).
 */
export function findNearestStation(
  coords: Coordinates,
  stations: StationData[],
  options?: SuggestStationOptions,
): StationSuggestion | null {
  const candidates = findCandidateStations(coords, stations, 1, options);
  return candidates[0] ?? null;
}

/**
 * Phase 2 Transit Inference Engine:
 * Intelligently suggests either station platform arrival (AT_STATION)
 * or in-transit train movement between two stations (IN_TRANSIT).
 */
export function findTransitSuggestion(
  coords: Coordinates,
  stations: StationData[],
  options?: SuggestStationOptions,
): TransitSuggestion | null {
  if (!coords || !Array.isArray(stations) || stations.length === 0) {
    return null;
  }

  const atStationThreshold = options?.atStationThresholdMeters ?? DEFAULT_AT_STATION_THRESHOLD_METERS;
  const segmentThreshold = options?.segmentThresholdMeters ?? DEFAULT_SEGMENT_THRESHOLD_METERS;
  const nearThreshold = options?.nearStationThresholdMeters ?? DEFAULT_NEAR_STATION_THRESHOLD_METERS;

  // Step 1: Find candidate stations within 5km
  const candidateStations = findCandidateStations(coords, stations, 8, options);
  if (candidateStations.length === 0) {
    return null;
  }

  const nearest = candidateStations[0];

  // Step 2: If user is within station platform threshold (e.g. <= 250m), return AT_STATION
  if (nearest.distanceMeters <= atStationThreshold) {
    return {
      type: 'STATION',
      proximity: 'AT_STATION',
      station: nearest.station,
      distanceMeters: nearest.distanceMeters,
      displayText: nearest.displayText,
      formattedDistance: nearest.formattedDistance,
    };
  }

  // Step 3: Evaluate in-transit segments from nearby station connections
  const stationMap = new Map<string, StationData>();
  for (const c of candidateStations) {
    stationMap.set(c.station.id, c.station);
  }

  const candidateSegments: TransitSegment[] = [];
  const visitedSegmentKeys = new Set<string>();

  for (const cand of candidateStations) {
    const stationA = cand.station;
    if (!stationA.next || stationA.next.length === 0) continue;

    for (const conn of stationA.next) {
      const bId = conn.to;
      const segKey = stationA.id < bId
        ? `${conn.line}_${stationA.id}_${bId}`
        : `${conn.line}_${bId}_${stationA.id}`;

      if (visitedSegmentKeys.has(segKey)) continue;
      visitedSegmentKeys.add(segKey);

      // Find station B (either from candidateStations or full stations list)
      let stationB = stationMap.get(bId);
      if (!stationB) {
        stationB = stations.find(s => s.id === bId);
        if (stationB) {
          stationMap.set(bId, stationB);
        }
      }
      if (!stationB) continue;

      const segResult = calculatePointToSegmentDistance(
        coords,
        { latitude: stationA.lat, longitude: stationA.lng },
        { latitude: stationB.lat, longitude: stationB.lng },
      );

      // Must be between stations and within track buffer threshold
      if (
        segResult.isBetween &&
        segResult.crossTrackDistanceMeters <= segmentThreshold
      ) {
        candidateSegments.push({
          lineName: conn.line,
          stationA,
          stationB,
          crossTrackDistanceMeters: Math.round(segResult.crossTrackDistanceMeters),
          projectionRatio: segResult.projectionRatio,
        });
      }
    }
  }

  // If matching transit segments found, choose the one closest to track
  if (candidateSegments.length > 0) {
    candidateSegments.sort(
      (a, b) => a.crossTrackDistanceMeters - b.crossTrackDistanceMeters,
    );
    const bestSegment = candidateSegments[0];

    let headingStation: StationData | undefined;
    if (options?.previousCoords) {
      const headingResult = inferSegmentHeading(
        coords,
        options.previousCoords,
        bestSegment.stationA,
        bestSegment.stationB,
        options.minHeadingMoveMeters,
      );
      if (headingResult) {
        headingStation = headingResult.headingStation;
        bestSegment.headingStation = headingStation;
      }
    }

    return {
      type: 'SEGMENT',
      proximity: 'IN_TRANSIT',
      segment: bestSegment,
      distanceMeters: bestSegment.crossTrackDistanceMeters,
      displayText: formatSegmentLabel(
        bestSegment.lineName,
        bestSegment.stationA,
        bestSegment.stationB,
        headingStation,
      ),
      formattedDistance: `線路から${formatDistanceMeters(bestSegment.crossTrackDistanceMeters)}`,
      headingStation,
    };
  }

  // Step 4: Fallback to nearest station
  return {
    type: 'STATION',
    proximity: nearest.distanceMeters <= nearThreshold ? 'NEAR_STATION' : 'FAR',
    station: nearest.station,
    distanceMeters: nearest.distanceMeters,
    displayText: nearest.displayText,
    formattedDistance: nearest.formattedDistance,
  };
}

/**
 * Finds all candidate transit suggestions (both segment and station options) for user selection.
 */
export function findCandidateTransitSuggestions(
  coords: Coordinates,
  stations: StationData[],
  options?: SuggestStationOptions,
): TransitSuggestion[] {
  const primary = findTransitSuggestion(coords, stations, options);
  if (!primary) return [];

  const candidates: TransitSuggestion[] = [primary];
  const stationCandidates = findCandidateStations(coords, stations, 4, options);

  for (const st of stationCandidates) {
    // Avoid duplicate if primary is the same station
    if (primary.type === 'STATION' && primary.station?.id === st.station.id) {
      continue;
    }
    candidates.push({
      type: 'STATION',
      proximity: st.proximity,
      station: st.station,
      distanceMeters: st.distanceMeters,
      displayText: st.displayText,
      formattedDistance: st.formattedDistance,
    });
  }

  return candidates;
}
