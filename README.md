# map-viewer

Offline-capable PWA for viewing the [Of Milk and Navvies](https://bikepacking.com/routes/of-milk-and-navvies/)
bikepacking route (Mjølkevegen and Rallarvegen, Norway) with no signal.

**Live app: https://ericpedley.github.io/map-viewer/**

- Route selector (🗺️ Routes): switch between the Of Milk and Navvies GPX route
  and the four Garmin "Bike Camp" loop courses. The choice is remembered, and
  every route's data is precached by the service worker so any of them opens
  offline.
- Route track (colored by grade — blue descents, white flat, red climbs) +
  65 points of interest (resupply, lodging, camping, water, sights) baked
  in from the official GPX, no network needed to see them.
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
- Version number shown small at the bottom of the screen — comes from
  `package.json`'s `version` field (see `vite.config.js`'s `define`), so
  that's the one place to bump it when tagging a release.

## Development

```
npm install
npm run dev
```

`npm run dev` / `npm run build` first run `npm run convert-routes`, which
regenerates `src/data/routes/*.json` (one file per route) and
`src/data/routes-index.json` (the list the selector reads) from
`source-data/`, then start Vite / produce a production build in `dist/`.

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

## Updating / adding routes

- **Garmin courses (`.fit`)**: drop the file into `source-data/routes/` and
  rebuild. It shows up in the selector automatically, named after the
  course's own name. Course points (e.g. "Water") become POIs. Parsing is
  done by `scripts/convert-fit.mjs` using Garmin's `@garmin/fitsdk`.
- **The GPX route**: replace `source-data/route.gpx` (track points in a `<trk>`,
  named POIs as `<wpt>` elements) and rerun `npm run convert-routes`.
  Turn-by-turn cues come from a separate `source-data/cues.gpx` cue-sheet
  export — its waypoints are matched by name against the turn vocabulary in
  `scripts/convert-gpx.mjs` (`Left`, `Right`, `Slight Left`, etc).

Each route is its own lazy-loaded chunk, so adding routes doesn't slow the
initial load. The offline tile cache is shared across routes, but "Download
offline map" fetches the corridor for whichever route is currently selected,
so run it once per route you plan to ride.

## Turn-by-turn cues and convenience stores from OpenStreetMap

FIT courses have no turn instructions, so these are derived from OSM:

```
npm run fetch-osm              # new/changed FIT routes
npm run fetch-osm -- --force   # refetch everything
```

`scripts/fetch-osm.mjs` asks the Overpass API for the roads within 25 m of
each route and for convenience stores, supermarkets and gas stations within
500 m (~0.3 mi). `scripts/osm-turns.mjs` then:

- builds a road graph and finds the junctions the route passes through;
- measures the route's heading before/after each one to get the turn angle;
- emits a cue only where a real choice existed (another road branches off) —
  going straight through a crossroads gets no cue, a Y-fork gets
  "Keep left/right";
- names the road you end up on, or describes it ("dirt road", "bike path")
  when OSM has no name, and collapses roundabouts to "take the 2nd exit";
- records each cue's exact distance along the route, so loops that retrace
  a road still count down correctly.

The small derived result is committed in `source-data/osm/<route>.json` and
merged in by `npm run convert-routes`, so normal builds need no network. It
records a hash of the track and is ignored (with a warning) if the course is
re-exported with different geometry. The **Fetch OSM data** GitHub Action
runs the fetch automatically when a `.fit` or the derivation code changes
(and on demand from the Actions tab) and commits the result.

Logic tests (synthetic street grids, forks, roundabouts, store filtering):
`npm test`.

Stores show as 🛒 Resupply (convenience/supermarket) or ⛽ Gas station POIs,
with "mi off route" and opening hours when OSM has them. Data © OpenStreetMap
contributors (ODbL); attribution is shown on the map.

POI filter chips only list categories present in the selected route, so the
single-day Bike Camp loops show just resupply / water / gas.
