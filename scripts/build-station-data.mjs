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

// Well-known circular lines that loop between first and last station
const LOOP_LINE_CODES = new Set([
  11302, // JR山手線
  11602, // JR大阪環状線
  24004, // 名古屋市営名城線
]);

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
  // stationCode -> Map of connectionKey to { line, to }
  const stationConnectionsMap = new Map();

  const lineFiles = fs.readdirSync(lineDir).filter(f => f.endsWith('.json'));
  for (const f of lineFiles) {
    try {
      const lineCode = Number(f.replace('.json', ''));
      const content = JSON.parse(fs.readFileSync(path.join(lineDir, f), 'utf-8'));
      const lineName = content.name;
      const list = content.station_list || [];
      const isLoop = LOOP_LINE_CODES.has(lineCode);

      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const code = Number(item.code);
        if (!stationLinesMap.has(code)) {
          stationLinesMap.set(code, new Set());
        }
        stationLinesMap.get(code).add(lineName);

        if (!stationConnectionsMap.has(code)) {
          stationConnectionsMap.set(code, new Map());
        }

        // Previous station on line
        if (i > 0) {
          const prevCode = String(list[i - 1].code);
          stationConnectionsMap.get(code).set(`${lineName}_${prevCode}`, { line: lineName, to: prevCode });
        } else if (isLoop && list.length > 2) {
          const lastCode = String(list[list.length - 1].code);
          stationConnectionsMap.get(code).set(`${lineName}_${lastCode}`, { line: lineName, to: lastCode });
        }

        // Next station on line
        if (i < list.length - 1) {
          const nextCode = String(list[i + 1].code);
          stationConnectionsMap.get(code).set(`${lineName}_${nextCode}`, { line: lineName, to: nextCode });
        } else if (isLoop && list.length > 2) {
          const firstCode = String(list[0].code);
          stationConnectionsMap.get(code).set(`${lineName}_${firstCode}`, { line: lineName, to: firstCode });
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
    const pref = Number(row.prefecture) || 0;

    if (!name || Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const lines = Array.from(stationLinesMap.get(code) || []);
    if (lines.length === 0) continue;

    const next = Array.from(stationConnectionsMap.get(code)?.values() || []);

    stations.push({
      id: String(code),
      name,
      lat: Math.round(lat * 1000000) / 1000000,
      lng: Math.round(lng * 1000000) / 1000000,
      pref,
      lines,
      next,
    });
  }

  console.log(`Generated ${stations.length} stations with verified lines & connections.`);

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
