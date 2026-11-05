// Converts the source GPX route into a compact JSON file bundled into the app,
// so the track/POIs are available offline without a runtime fetch or GPX parser.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { trackStats, writeRoute } from './route-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gpxPath = path.join(__dirname, '..', 'source-data', 'route.gpx');
const cuesPath = path.join(__dirname, '..', 'source-data', 'cues.gpx');

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

const id = 'of-milk-and-navvies';
writeRoute({
  id,
  name: 'Of Milk and Navvies (Mjølkevegen and Rallarvegen)',
  source: 'https://bikepacking.com/routes/of-milk-and-navvies/',
  track,
  ...trackStats(track),
  pois,
  cues,
});
