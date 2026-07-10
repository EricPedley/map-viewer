# map-viewer

Offline-capable PWA for viewing the [Of Milk and Navvies](https://bikepacking.com/routes/of-milk-and-navvies/)
bikepacking route (Mjølkevegen and Rallarvegen, Norway) with no signal.

**Live app: https://ericpedley.github.io/map-viewer/**

- Route track + 65 points of interest (resupply, lodging, camping, water, sights)
  baked in from the official GPX, no network needed to see them.
- Satellite basemap (Esri World Imagery).
- One-tap "Download offline map" caches satellite tiles for a corridor
  around the route (overview down to street-level zoom), so the map keeps
  working once you lose signal. Do this once before you set off, while you
  have wifi/data.
- Live location dot + compass heading arrow (GPS + device compass — both
  on-device sensors, so this works with no signal too).
- While location is on, the POI list sorts to what's coming up next and
  shows miles until you reach it, dropping anything you've already passed.
- Elevation chart shows percent grade (not raw elevation) so you can see
  how steep what's ahead actually is.
- "Follow" mode (only enabled while location is on): a Google Maps-style
  driving view — the map rotates to your heading and tilts for a pseudo-3D
  look-ahead perspective, with a turn-by-turn cue banner (from the route's
  cue sheet) showing the next turn and how far to it.
- Installable as a PWA (Add to Home Screen).

## Development

```
npm install
npm run dev
```

`npm run dev` / `npm run build` first regenerate `src/data/route.json` from
`source-data/route.gpx` (see `scripts/convert-gpx.mjs`), then start Vite /
produce a production build in `dist/`.

## Deploying

`npm run build` produces a static site in `dist/` — serve it from any static
host over HTTPS (required for service workers), e.g. GitHub Pages, Netlify,
Vercel, or Cloudflare Pages.

## Offline tiles: how it works

The service worker (configured in `vite.config.js` via `vite-plugin-pwa`)
registers a `CacheFirst` runtime-caching route for Esri World Imagery tile
URLs. The in-app "Offline" panel (`src/offline.js`) samples points along the
route every 200m, computes the map tiles needed to cover a corridor around
those points at a fixed zoom range (z12-16), and fetches each one — the
service worker transparently persists them into the same cache Leaflet
reads from when panning the map. There's no separate offline data format to
manage: online panning and offline pre-fetching both go through the same
cache.

Note on Esri World Imagery: it's used here because it requires no API key
and gives the best available resolution for route-planning purposes. Their
terms of use are ambiguous about bulk/offline tile caching for personal
use — this is common practice among hobbyist offline-map projects, but if
you outgrow "one person's personal bikepacking route," consider a provider
with an explicit offline license (e.g. MapTiler).

## Follow mode: how it works

`src/follow.js` rotates and tilts the map with a plain CSS transform on
wrapper elements around the Leaflet container, rather than using a
rotation-aware Leaflet fork — Leaflet itself keeps thinking north is up and
never finds out. That's why dragging/pinch-zoom are disabled while it's
active: those gestures need to translate an on-screen tap through the
rotated/tilted view back into a real map coordinate, which only Leaflet's
own (rotation-unaware) math does. The "look ahead" camera effect is done in
geographic space instead of pixel space — each position update centers the
map on a point projected ~70m ahead of the rider along their heading
(`destinationPoint` in `src/projection.js`), so the rider's actual dot ends
up lower on screen with more of the road ahead visible above it.

## Updating the route

Replace `source-data/route.gpx` with a new GPX (track points in a `<trk>`,
named POIs as `<wpt>` elements) and rerun `npm run convert-gpx` (or just
`npm run dev` / `npm run build`, which do it automatically). Turn-by-turn
cues (for follow mode's nav banner) come from a separate `source-data/cues.gpx`
cue-sheet export — its waypoints are matched by name against the turn
vocabulary in `scripts/convert-gpx.mjs` (`Left`, `Right`, `Slight Left`, etc).
