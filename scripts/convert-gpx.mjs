// Converts the source GPX route into a compact JSON file bundled into the app,
// so the track/POIs are available offline without a runtime fetch or GPX parser.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gpxPath = path.join(__dirname, '..', 'source-data', 'route.gpx');
const cuesPath = path.join(__dirname, '..', 'source-data', 'cues.gpx');
const outPath = path.join(__dirname, '..', 'src', 'data', 'route.json');

const xml = readFileSync(gpxPath, 'utf-8');
const doc = new DOMParser().parseFromString(xml, 'text/xml');

function text(el, tag) {
  const node = el.getElementsByTagName(tag)[0];
  return node && node.textContent ? node.textContent.trim() : '';
}

// Track points: [lat, lon, ele]
const track = [];
const trkpts = doc.getElementsByTagName('trkpt');
for (let i = 0; i < trkpts.length; i++) {
  const pt = trkpts[i];
  const lat = parseFloat(pt.getAttribute('lat'));
  const lon = parseFloat(pt.getAttribute('lon'));
  const ele = parseFloat(text(pt, 'ele')) || 0;
  track.push([lat, lon, ele]);
}

// Waypoints (POIs)
const pois = [];
const wpts = doc.getElementsByTagName('wpt');
for (let i = 0; i < wpts.length; i++) {
  const pt = wpts[i];
  const lat = parseFloat(pt.getAttribute('lat'));
  const lon = parseFloat(pt.getAttribute('lon'));
  const name = text(pt, 'name');
  const desc = text(pt, 'desc') || text(pt, 'cmt');
  if (!name) continue; // skip the two unnamed route-title bookends if present
  pois.push({ lat, lon, name, desc });
}

// Turn-by-turn cues (a separate export from the same route — its 285
// waypoints are mostly cue-sheet turns like "Left"/"Right"/"Slight Right"
// rather than named POIs, so it's kept as its own source file and only the
// actual turn waypoints are pulled out here).
const TURN_NAMES = new Set([
  'Left',
  'Right',
  'Straight',
  'Slight Left',
  'Slight Right',
  'Sharp Left',
  'Sharp Right',
  'Uturn',
  'U-turn',
]);

const cues = [];
const cuesXml = readFileSync(cuesPath, 'utf-8');
const cuesDoc = new DOMParser().parseFromString(cuesXml, 'text/xml');
const cueWpts = cuesDoc.getElementsByTagName('wpt');
for (let i = 0; i < cueWpts.length; i++) {
  const pt = cueWpts[i];
  const direction = text(pt, 'name');
  if (!TURN_NAMES.has(direction)) continue;
  const lat = parseFloat(pt.getAttribute('lat'));
  const lon = parseFloat(pt.getAttribute('lon'));
  const instruction = text(pt, 'desc') || text(pt, 'cmt') || direction;
  cues.push({ lat, lon, direction, instruction });
}

// Cumulative distance (meters) along the track, using the haversine formula,
// so the elevation profile can be plotted against distance instead of point index.
function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let dist = 0;
let gain = 0;
let loss = 0;
const distances = [0];
for (let i = 1; i < track.length; i++) {
  dist += haversine(track[i - 1], track[i]);
  distances.push(dist);
  const d = track[i][2] - track[i - 1][2];
  if (d > 0) gain += d;
  else loss += -d;
}

const data = {
  name: 'Of Milk and Navvies (Mjølkevegen and Rallarvegen)',
  source: 'https://bikepacking.com/routes/of-milk-and-navvies/',
  track,
  distances,
  totalDistanceMeters: Math.round(dist),
  elevationGainMeters: Math.round(gain),
  elevationLossMeters: Math.round(loss),
  pois,
  cues,
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(data));
console.log(
  `Wrote ${outPath}: ${track.length} track points, ${pois.length} POIs, ${cues.length} turn cues, ` +
    `${(dist / 1000).toFixed(1)} km, +${Math.round(gain)}m/-${Math.round(loss)}m`
);
