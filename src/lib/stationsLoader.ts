import type { StationData } from '../game/stationInference';

let cachedStations: StationData[] | null = null;
let inFlightPromise: Promise<StationData[]> | null = null;

export function getCachedStations(): StationData[] | null {
  return cachedStations;
}

export function loadStations(): Promise<StationData[]> {
  if (cachedStations) {
    return Promise.resolve(cachedStations);
  }
  if (inFlightPromise) {
    return inFlightPromise;
  }

  inFlightPromise = fetch('/data/stations.json')
    .then(async response => {
      if (!response.ok) {
        throw new Error(`Failed to fetch station data (${response.status})`);
      }
      const data = (await response.json()) as StationData[];
      if (!Array.isArray(data)) {
        throw new Error('Invalid station data format');
      }
      cachedStations = data;
      return data;
    })
    .catch(error => {
      inFlightPromise = null;
      throw error;
    });

  return inFlightPromise;
}
