import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  calculatePointToSegmentDistance,
  findCandidateStations,
  findCandidateTransitSuggestions,
  findNearestStation,
  findTransitSuggestion,
  formatDistanceMeters,
  formatSegmentLabel,
  formatStationLabel,
} from '../../src/game/stationInference.ts';

const mockStations = [
  {
    id: '100201',
    name: '東京',
    kana: 'とうきょう',
    lat: 35.681391,
    lng: 139.766103,
    pref: 13,
    lines: ['東海道新幹線', 'JR山手線', '東京メトロ丸ノ内線'],
  },
  {
    id: '1130225',
    name: '有楽町',
    kana: 'ゆうらくちょう',
    lat: 35.675069,
    lng: 139.763328,
    pref: 13,
    lines: ['JR山手線', 'JR京浜東北線', '東京メトロ有楽町線'],
  },
  {
    id: '1130223',
    name: '神田',
    kana: 'かんだ',
    lat: 35.69169,
    lng: 139.770883,
    pref: 13,
    lines: ['JR山手線', 'JR中央線(快速)', '東京メトロ銀座線'],
  },
  {
    id: 'single_line',
    name: 'ローカル単線駅',
    lat: 36.000000,
    lng: 140.000000,
    lines: ['のどか線'],
  },
  {
    id: 'two_lines',
    name: '乗換駅',
    lat: 36.100000,
    lng: 140.100000,
    lines: ['本線', '支線'],
  },
  {
    id: 'no_lines',
    name: '線路なし駅',
    lat: 36.200000,
    lng: 140.200000,
    lines: [],
  },
];

test('formatStationLabel formatting', () => {
  assert.equal(formatStationLabel(mockStations[5]), '線路なし駅');
  assert.equal(formatStationLabel(mockStations[3]), 'ローカル単線駅 (のどか線)');
  assert.equal(formatStationLabel(mockStations[4]), '乗換駅 (本線 / 支線)');
  assert.equal(formatStationLabel(mockStations[0]), '東京 (東海道新幹線 / JR山手線 他)');
});

test('formatDistanceMeters formatting', () => {
  assert.equal(formatDistanceMeters(8), '約10m');
  assert.equal(formatDistanceMeters(84), '約80m');
  assert.equal(formatDistanceMeters(256), '約260m');
  assert.equal(formatDistanceMeters(999), '約1000m');
  assert.equal(formatDistanceMeters(1240), '約1.2km');
  assert.equal(formatDistanceMeters(3499), '約3.5km');
});

test('findCandidateStations empty or invalid coordinates', () => {
  assert.deepEqual(findCandidateStations(null, mockStations), []);
  assert.deepEqual(findCandidateStations({ latitude: 35.68, longitude: 139.76 }, []), []);
});

test('findCandidateStations ordering and proximity detection', () => {
  // Near Tokyo station platform (~50m away)
  const coordsAtTokyo = { latitude: 35.6815, longitude: 139.7663 };
  const candidates = findCandidateStations(coordsAtTokyo, mockStations, 3);

  assert.equal(candidates.length, 3);
  // Tokyo is closest
  assert.equal(candidates[0].station.name, '東京');
  assert.equal(candidates[0].proximity, 'AT_STATION');
  assert.ok(candidates[0].distanceMeters <= 50);

  // Yurakucho and Kanda are further away (around 700m - 1200m)
  assert.ok(candidates[1].distanceMeters > candidates[0].distanceMeters);
  assert.ok(['NEAR_STATION', 'FAR'].includes(candidates[1].proximity));
});

test('findNearestStation returns best suggestion or null when out of range', () => {
  const coordsAtTokyo = { latitude: 35.6815, longitude: 139.7663 };
  const best = findNearestStation(coordsAtTokyo, mockStations);
  assert.ok(best !== null);
  assert.equal(best.station.name, '東京');
  assert.equal(best.proximity, 'AT_STATION');

  // Coords in middle of ocean (far away from any mock station)
  const oceanCoords = { latitude: 20.0, longitude: 130.0 };
  const none = findNearestStation(oceanCoords, mockStations, { maxDistanceMeters: 5000 });
  assert.equal(none, null);
});

test('real stations.json dataset verification', () => {
  const filePath = path.resolve('src/data/stations.json');
  assert.ok(fs.existsSync(filePath), 'src/data/stations.json must exist');

  const allStations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.ok(allStations.length >= 8000, 'Must have at least 8000 active stations');

  // Test Tokyo station detection
  const tokyoCoords = { latitude: 35.681236, longitude: 139.767125 };
  const tokyoSuggestion = findNearestStation(tokyoCoords, allStations);
  assert.ok(tokyoSuggestion !== null);
  assert.equal(tokyoSuggestion.station.name, '東京');
  assert.equal(tokyoSuggestion.proximity, 'AT_STATION');
  assert.ok(tokyoSuggestion.station.lines.includes('JR山手線'));

  // Test Shinjuku station detection
  const shinjukuCoords = { latitude: 35.689729, longitude: 139.700464 };
  const shinjukuSuggestion = findNearestStation(shinjukuCoords, allStations);
  assert.ok(shinjukuSuggestion !== null);
  assert.equal(shinjukuSuggestion.station.name, '新宿');
  assert.equal(shinjukuSuggestion.proximity, 'AT_STATION');
  assert.ok(shinjukuSuggestion.station.lines.includes('JR中央線(快速)'));
});

test('calculatePointToSegmentDistance calculates orthogonal distance and projection ratio', () => {
  const stationA = { latitude: 35.658871, longitude: 139.701238 }; // Shibuya
  const stationB = { latitude: 35.646685, longitude: 139.710070 }; // Ebisu

  // Exact midpoint
  const midPoint = {
    latitude: (stationA.latitude + stationB.latitude) / 2,
    longitude: (stationA.longitude + stationB.longitude) / 2,
  };
  const midResult = calculatePointToSegmentDistance(midPoint, stationA, stationB);
  assert.equal(midResult.isBetween, true);
  assert.ok(Math.abs(midResult.projectionRatio - 0.5) < 0.01);
  assert.ok(midResult.crossTrackDistanceMeters < 10);

  // Point beyond station B (t > 1)
  const beyondB = { latitude: 35.635, longitude: 139.72 };
  const beyondResult = calculatePointToSegmentDistance(beyondB, stationA, stationB);
  assert.equal(beyondResult.isBetween, false);
  assert.ok(beyondResult.projectionRatio > 1);

  // Identical points (degenerate segment)
  const degenResult = calculatePointToSegmentDistance(stationA, stationA, stationA);
  assert.equal(degenResult.isBetween, false);
  assert.equal(degenResult.crossTrackDistanceMeters, 0);
});

test('formatSegmentLabel formats transit line and endpoints correctly', () => {
  const stA = { id: '1', name: '渋谷', lat: 0, lng: 0, lines: [] };
  const stB = { id: '2', name: '恵比寿', lat: 0, lng: 0, lines: [] };
  assert.equal(formatSegmentLabel('JR山手線', stA, stB), 'JR山手線 渋谷〜恵比寿間');
});

test('findTransitSuggestion identifies in-transit segment between Shibuya and Ebisu', () => {
  const filePath = path.resolve('src/data/stations.json');
  const allStations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Midpoint between Shibuya and Ebisu on Yamanote Line
  const midPoint = { latitude: 35.652778, longitude: 139.705654 };
  const suggestion = findTransitSuggestion(midPoint, allStations);

  assert.ok(suggestion !== null);
  assert.equal(suggestion.type, 'SEGMENT');
  assert.equal(suggestion.proximity, 'IN_TRANSIT');
  assert.ok(suggestion.displayText.includes('恵比寿〜渋谷間') || suggestion.displayText.includes('渋谷〜恵比寿間'));
  assert.ok(suggestion.displayText.includes('JR山手線'));
  assert.ok(suggestion.formattedDistance.startsWith('線路から'));

  // Candidates list includes segment as top suggestion, followed by nearby stations
  const candidates = findCandidateTransitSuggestions(midPoint, allStations);
  assert.ok(candidates.length >= 2);
  assert.equal(candidates[0].type, 'SEGMENT');
  assert.equal(candidates[0].proximity, 'IN_TRANSIT');
  assert.ok(candidates.some(c => c.type === 'STATION' && (c.station?.name === '渋谷' || c.station?.name === '恵比寿')));
});

test('findTransitSuggestion prioritizes AT_STATION when within station threshold', () => {
  const filePath = path.resolve('src/data/stations.json');
  const allStations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Tokyo Station platform
  const tokyoCoords = { latitude: 35.681236, longitude: 139.767125 };
  const suggestion = findTransitSuggestion(tokyoCoords, allStations);

  assert.ok(suggestion !== null);
  assert.equal(suggestion.type, 'STATION');
  assert.equal(suggestion.proximity, 'AT_STATION');
  assert.ok(suggestion.station?.name === '東京');
});

