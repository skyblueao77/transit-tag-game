import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const TARBALL_URL = 'https://api.github.com/repos/Seo-4d696b75/station_database/tarball/main';
const TMP_DIR = '/tmp/station_db';
const OUTPUT_FILE = path.resolve('src/data/stations.json');

function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= header.length) {
      const obj = {};
      for (let h = 0; h < header.length; h++) {
        obj[header[h]] = parts[h];
      }
      rows.push(obj);
    }
  }
  return rows;
}


async function main() {
  console.log('Downloading and extracting station_database tarball...');
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  execSync(`curl -sL "${TARBALL_URL}" | tar -xzf - --strip-components=1 -C "${TMP_DIR}"`, { stdio: 'inherit' });

  const stationCsvPath = path.join(TMP_DIR, 'src/station.csv');
  const lineDir = path.join(TMP_DIR, 'src/line');

  console.log('Reading line files...');
  // stationCode -> Set of lineNames
  const stationLinesMap = new Map();
  // stationCode -> Set of neighbor station codes (for future Phase 2 graph)
  const stationNeighborsMap = new Map();

  const lineFiles = fs.readdirSync(lineDir).filter(f => f.endsWith('.json'));
  for (const f of lineFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(lineDir, f), 'utf-8'));
      const lineName = content.name;
      const list = content.station_list || [];
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const code = Number(item.code);
        if (!stationLinesMap.has(code)) {
          stationLinesMap.set(code, new Set());
        }
        stationLinesMap.get(code).add(lineName);

        // Record neighbor stations
        if (!stationNeighborsMap.has(code)) {
          stationNeighborsMap.set(code, new Set());
        }
        if (i > 0) {
          stationNeighborsMap.get(code).add(Number(list[i - 1].code));
        }
        if (i < list.length - 1) {
          stationNeighborsMap.get(code).add(Number(list[i + 1].code));
        }
      }
    } catch (e) {
      console.warn(`Failed to parse line file ${f}:`, e.message);
    }
  }

  console.log('Reading station.csv...');
  const stationCsv = fs.readFileSync(stationCsvPath, 'utf-8');
  const stationRows = parseCsv(stationCsv);

  const stations = [];
  for (const row of stationRows) {
    if (row.closed !== '0') continue;
    const code = Number(row.code);
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    const name = row.name;
    const kana = row.name_kana || '';
    const pref = Number(row.prefecture) || 0;

    if (!name || Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const lines = Array.from(stationLinesMap.get(code) || []);
    // If no line found via line files, skip or placeholder
    if (lines.length === 0) {
      continue;
    }

    stations.push({
      id: String(code),
      name,
      kana,
      lat: Math.round(lat * 1000000) / 1000000,
      lng: Math.round(lng * 1000000) / 1000000,
      pref,
      lines,
    });
  }

  console.log(`Generated ${stations.length} stations with verified lines.`);

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(stations));
  const stats = fs.statSync(OUTPUT_FILE);
  console.log(`Output written to ${OUTPUT_FILE} (${(stats.size / 1024).toFixed(1)} KB)`);

  // Cleanup
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
