// Writes src/data/routes-index.json: a tiny list of every converted route
// (id, name, distance, climbing, ...) that the route selector reads. The full
// per-route track files are lazy-loaded only when a route is picked, so the
// selector itself stays cheap.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ROUTES_OUT_DIR } from './route-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '..', 'src', 'data', 'routes-index.json');

// The original GPX route stays first (and is the default); everything else is
// listed shortest to longest.
const DEFAULT_ID = 'of-milk-and-navvies';

const routes = readdirSync(ROUTES_OUT_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const r = JSON.parse(readFileSync(path.join(ROUTES_OUT_DIR, f), 'utf-8'));
    return {
      id: r.id,
      name: r.name,
      totalDistanceMeters: r.totalDistanceMeters,
      elevationGainMeters: r.elevationGainMeters,
      elevationLossMeters: r.elevationLossMeters,
      poiCount: r.pois.length,
    };
  })
  .sort((a, b) => {
    if (a.id === DEFAULT_ID) return -1;
    if (b.id === DEFAULT_ID) return 1;
    return a.totalDistanceMeters - b.totalDistanceMeters;
  });

writeFileSync(outPath, JSON.stringify({ defaultId: DEFAULT_ID, routes }));
console.log(`Wrote ${path.relative(process.cwd(), outPath)}: ${routes.length} routes`);
