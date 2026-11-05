// Shared helpers for the route converters (GPX + FIT) so every route ends up
// with the same JSON shape: { id, name, track, distances, totals, pois, cues }.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROUTES_OUT_DIR = path.join(__dirname, '..', 'src', 'data', 'routes');

export function haversine(a, b) {
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

// Cumulative distance (meters) along the track plus total ascent/descent,
// so the elevation profile can be plotted against distance, not point index.
export function trackStats(track) {
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
  return {
    distances: distances.map((d) => Math.round(d * 10) / 10),
    totalDistanceMeters: Math.round(dist),
    elevationGainMeters: Math.round(gain),
    elevationLossMeters: Math.round(loss),
  };
}

export function writeRoute(route) {
  mkdirSync(ROUTES_OUT_DIR, { recursive: true });
  const outPath = path.join(ROUTES_OUT_DIR, `${route.id}.json`);
  writeFileSync(outPath, JSON.stringify(route));
  console.log(
    `Wrote ${path.relative(process.cwd(), outPath)}: ${route.track.length} track points, ` +
      `${route.pois.length} POIs, ${route.cues.length} turn cues, ` +
      `${(route.totalDistanceMeters / 1000).toFixed(1)} km, ` +
      `+${route.elevationGainMeters}m/-${route.elevationLossMeters}m`
  );
}

// Fingerprint of a route's geometry. The OSM-derived data in source-data/osm/
// is only valid for the exact track it was computed from, so it records this
// hash and the converter ignores (with a warning) a file whose hash no longer
// matches — e.g. after the .fit course was edited and re-exported.
import { createHash } from 'node:crypto';
export function trackHash(track) {
  return createHash('sha1')
    .update(track.map(([lat, lon]) => `${lat},${lon}`).join(';'))
    .digest('hex')
    .slice(0, 16);
}

export const OSM_DIR = path.join(__dirname, '..', 'source-data', 'osm');
