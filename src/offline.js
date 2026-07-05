// Corridor-based offline tile downloader. Rather than caching a bounding box
// around the whole route (which would pull in huge irrelevant areas for a
// long point-to-point route), this samples points along the track and caches
// only the tiles near those points, at whichever zoom levels the user picks.
//
// Downloaded tiles land in Cache Storage under TILE_CACHE_NAME because the
// service worker (see src/sw-runtime.js / vite.config.js) registers a
// CacheFirst runtime-caching route for the same tile URL pattern. A plain
// fetch() here is intercepted by that route and persisted, so this module
// doesn't need to touch the Cache API directly.

export const TILE_CACHE_NAME = 'satellite-tiles-v1';

export const SATELLITE_URL_TEMPLATE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

function tileUrl(z, x, y) {
  return SATELLITE_URL_TEMPLATE.replace('{z}', z).replace('{y}', y).replace('{x}', x);
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return [x, y];
}

// Samples the track at roughly `spacingMeters` intervals using the
// precomputed cumulative-distance array, so sampling density doesn't depend
// on the (uneven) recording density of the original GPX.
function sampleTrack(track, distances, spacingMeters) {
  const points = [];
  let nextAt = 0;
  for (let i = 0; i < track.length; i++) {
    if (distances[i] >= nextAt) {
      points.push(track[i]);
      nextAt += spacingMeters;
    }
  }
  return points;
}

/**
 * Computes the deduplicated set of tiles needed to cover the route corridor.
 * @param {number[][]} track - array of [lat, lon, ele]
 * @param {number[]} distances - cumulative meters, same length as track
 * @param {number[]} zooms - zoom levels to include
 * @param {number} bufferTiles - extra tiles in each direction around each sample (0 = just the tile the point falls in)
 * @param {number} spacingMeters - sampling interval along the track
   */
export function computeCorridorTiles(track, distances, zooms, bufferTiles, spacingMeters) {
  const samples = sampleTrack(track, distances, spacingMeters);
  const seen = new Set();
  const tiles = [];
  for (const z of zooms) {
    for (const [lat, lon] of samples) {
      const [cx, cy] = lonLatToTile(lon, lat, z);
      for (let dx = -bufferTiles; dx <= bufferTiles; dx++) {
        for (let dy = -bufferTiles; dy <= bufferTiles; dy++) {
          const x = cx + dx;
          const y = cy + dy;
          const key = `${z}/${x}/${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tiles.push({ z, x, y, url: tileUrl(z, x, y) });
        }
      }
    }
  }
  return tiles;
}

/**
 * Downloads a list of tiles with bounded concurrency, reporting progress.
 * Returns an object with a `promise` that resolves when done/cancelled, and
 * a `cancel()` method.
 */
export function downloadTiles(tiles, { concurrency = 6, onProgress } = {}) {
  let cancelled = false;
  let done = 0;
  let failed = 0;
  let index = 0;

  async function worker() {
    while (index < tiles.length) {
      if (cancelled) return;
      const tile = tiles[index++];
      try {
        const res = await fetch(tile.url);
        if (!res.ok) failed++;
      } catch {
        failed++;
      }
      done++;
      if (onProgress) onProgress({ done, failed, total: tiles.length, cancelled });
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  const promise = Promise.all(workers).then(() => ({ done, failed, cancelled }));

  return { promise, cancel: () => (cancelled = true) };
}

export async function clearTileCache() {
  await caches.delete(TILE_CACHE_NAME);
}

export async function getCachedTileCount() {
  if (!('caches' in window)) return 0;
  const has = await caches.has(TILE_CACHE_NAME);
  if (!has) return 0;
  const cache = await caches.open(TILE_CACHE_NAME);
  const keys = await cache.keys();
  return keys.length;
}
