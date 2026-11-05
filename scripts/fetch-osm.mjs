// Fetches OpenStreetMap data around each FIT route from the Overpass API and
// derives two things from it (see osm-turns.mjs):
//   - turn-by-turn cues  (roads near the route -> junctions the route turns at)
//   - convenience-store / gas-station POIs within ~0.3 mi of the route
// The small derived result is written to source-data/osm/<route-id>.json and
// committed, so normal builds need no network and are reproducible. Run this
// on your own machine when a route is added or changed, then commit the result:
//
//   npm run fetch-osm                 # every FIT route that's new or changed
//   npm run fetch-osm -- --force      # refetch everything
//   npm run fetch-osm -- bike-camp-3-hour-loop
//
// Raw Overpass responses are cached in .cache/overpass/ (gitignored) so
// re-running after tweaking the turn logic doesn't hit the API again.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deriveStores, deriveTurnCues, simplifyTrack } from './osm-turns.mjs';
import { OSM_DIR, ROUTES_OUT_DIR, trackHash } from './route-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIT_DIR = path.join(__dirname, '..', 'source-data', 'routes');
const CACHE_DIR = path.join(__dirname, '..', '.cache', 'overpass');

// Public Overpass instances, tried in order. Be a polite client: identify
// ourselves, run requests one at a time, back off on 429/504. (kumi.systems
// and private.coffee were dropped: they timed out or returned empty results.)
const ENDPOINTS = process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const USER_AGENT = 'map-viewer-osm-fetch/1.0 (+https://github.com/EricPedley/map-viewer)';
const ROAD_RADIUS_METERS = 25; // roads this close to the route are loaded (incl. side roads at junctions)
const STORE_RADIUS_METERS = 500; // ~0.3 mi detour
const CHUNK_VERTICES = 200; // polyline vertices per request, keeps each query small
const NON_BIKEABLE = 'motorway|motorway_link|footway|steps|pedestrian|corridor|construction|proposed|razed|abandoned|platform|elevator';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// allowEmpty: whether zero elements is a legitimate answer. Every chunk of a
// route is on some road, so an empty roads response means an overloaded server
// silently gave up — treat it as a failure (retry, never cache). A stretch with
// no stores is real, so store queries pass allowEmpty: true.
async function overpass(query, { allowEmpty = false } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, createHash('sha1').update(query).digest('hex') + '.json');
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    if (allowEmpty || cached.elements?.length) return cached;
    console.warn('  ignoring cached empty response, refetching');
  }

  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
      const json = await res.json();
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(`${endpoint} -> ${json.remark}`);
      if (!Array.isArray(json.elements)) throw new Error(`${endpoint} -> response has no elements array`);
      if (!allowEmpty && json.elements.length === 0) throw new Error(`${endpoint} -> empty result`);
      writeFileSync(cacheFile, JSON.stringify(json));
      await sleep(1500);
      return json;
    } catch (err) {
      lastErr = err;
      console.warn(`  overpass attempt ${attempt + 1} failed: ${err.message}`);
      await sleep(5000 * (attempt + 1));
    }
  }
  throw lastErr;
}

const coordList = (pts) => pts.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(',');

function chunks(pts, size) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i += size - 1) out.push(pts.slice(i, i + size));
  return out;
}

async function processRoute(id, force) {
  const routeFile = path.join(ROUTES_OUT_DIR, `${id}.json`);
  if (!existsSync(routeFile)) throw new Error(`${routeFile} missing — run "npm run convert-routes" first`);
  const route = JSON.parse(readFileSync(routeFile, 'utf-8'));
  const hash = trackHash(route.track);
  const outFile = path.join(OSM_DIR, `${id}.json`);

  if (!force && existsSync(outFile) && JSON.parse(readFileSync(outFile, 'utf-8')).trackHash === hash) {
    console.log(`${id}: up to date (use --force to refetch)`);
    return;
  }

  const line = simplifyTrack(route.track, 15);
  const pieces = chunks(line, CHUNK_VERTICES);
  console.log(`${id}: ${route.track.length} points -> ${line.length} query vertices in ${pieces.length} chunk(s)`);

  const ways = new Map();
  const stores = new Map();
  for (const [n, piece] of pieces.entries()) {
    const coords = coordList(piece);
    console.log(`  chunk ${n + 1}/${pieces.length}: roads`);
    const roads = await overpass(
      `[out:json][timeout:180];way["highway"]["highway"!~"^(${NON_BIKEABLE})$"](around:${ROAD_RADIUS_METERS},${coords});out body geom;`
    );
    for (const el of roads.elements) if (el.type === 'way') ways.set(el.id, el);

    console.log(`  chunk ${n + 1}/${pieces.length}: stores`);
    const shops = await overpass(
      `[out:json][timeout:180];(nwr["shop"~"^(convenience|supermarket|grocery|general)$"](around:${STORE_RADIUS_METERS},${coords});` +
        `nwr["amenity"="fuel"](around:${STORE_RADIUS_METERS},${coords}););out center tags;`,
      { allowEmpty: true }
    );
    for (const el of shops.elements) stores.set(`${el.type}/${el.id}`, el);
  }

  // An empty road set means the API silently returned nothing (overloaded
  // server, etc.). Fail loudly rather than commit a file with no cues.
  if (ways.size === 0) throw new Error(`${id}: Overpass returned no roads — try again later`);

  const cues = deriveTurnCues(route.track, route.distances, [...ways.values()]);
  const pois = deriveStores(route.track, [...stores.values()], { maxOffRouteMeters: STORE_RADIUS_METERS });
  console.log(`  ${ways.size} roads -> ${cues.length} turn cues; ${stores.size} candidates -> ${pois.length} stores`);

  mkdirSync(OSM_DIR, { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        id,
        trackHash: hash,
        source: '© OpenStreetMap contributors (ODbL), via the Overpass API',
        cues,
        stores: pois,
      },
      null,
      1
    ) + '\n'
  );
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const requested = args.filter((a) => !a.startsWith('--'));
const ids = (requested.length
  ? requested
  : readdirSync(FIT_DIR).filter((f) => f.toLowerCase().endsWith('.fit')).map((f) => path.basename(f, path.extname(f)))
).sort();

for (const id of ids) await processRoute(id, force);
