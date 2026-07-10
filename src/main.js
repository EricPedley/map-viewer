import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import routeData from './data/route.json';
import { categorize, allCategories } from './poi.js';
import {
  SATELLITE_URL_TEMPLATE,
  computeCorridorTiles,
  downloadTiles,
  clearTileCache,
  getCachedTileCount,
} from './offline.js';
import { renderElevationProfile } from './elevation.js';
import { createLocationTracker } from './geolocation.js';
import { nearestRouteDistanceMeters, metersToMiles } from './projection.js';
import { createFollowMode } from './follow.js';
import { gradeProfile, gradeColor } from './grade.js';

// __APP_VERSION__ is injected at build time from package.json (see
// vite.config.js) so there's one source of truth for the version number.
document.getElementById('app-version').textContent = `v${__APP_VERSION__}`;

// ---------- Map setup ----------
// preferCanvas: the track is drawn as ~950 separate colored polyline
// segments (one per grade sample) rather than one path — canvas batches
// them onto a single layer instead of ~950 individual SVG DOM nodes.
const map = L.map('map', { zoomControl: false, attributionControl: true, preferCanvas: true });
L.control.zoom({ position: 'bottomright' }).addTo(map);

const satellite = L.tileLayer(SATELLITE_URL_TEMPLATE, {
  maxZoom: 18,
  maxNativeZoom: 17,
  // Follow mode enlarges #map to ~2.6x viewport size to cover the tilted
  // view's perspective-compressed far edge (see style.css) — keepBuffer
  // needs to be generous enough that the whole enlarged area gets tiles,
  // not just the part that happened to already be visible pre-enlarge.
  keepBuffer: 10,
  attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
}).addTo(map);

const latlngs = routeData.track.map(([lat, lon]) => [lat, lon]);
map.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24] });

// Track colored by grade (blue descents -> white flat -> red climbs)
// instead of one flat color — drawn as one polyline per grade segment,
// following the actual recorded path between each segment's endpoints
// (not a straight line between them) so curves stay accurate.
for (const seg of gradeProfile(routeData.track, routeData.distances)) {
  const segLatLngs = [];
  for (let i = seg.indexStart; i <= seg.indexEnd; i++) {
    segLatLngs.push([routeData.track[i][0], routeData.track[i][1]]);
  }
  L.polyline(segLatLngs, { color: gradeColor(seg.grade), weight: 4, opacity: 0.95 }).addTo(map);
}

function poiDivIcon(cat) {
  return L.divIcon({
    className: 'poi-icon',
    html: `<span style="background:${cat.color}">${cat.emoji}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

const poiMarkers = routeData.pois.map((poi) => {
  const cat = categorize(poi.name);
  const marker = L.marker([poi.lat, poi.lon], { icon: poiDivIcon(cat) });
  marker.bindPopup(
    `<strong>${escapeHtml(poi.name)}</strong>` +
      (poi.desc && poi.desc !== poi.name ? `<br>${escapeHtml(poi.desc)}` : '') +
      `<br><span class="popup-cat">${cat.emoji} ${cat.label}</span>`
  );
  marker.category = cat.id;
  marker.addTo(map);
  return marker;
});

// Where each POI falls along the route, in meters from the start — computed
// once since POIs don't move, then reused to sort/filter the POI list
// against the rider's live position.
const poiRouteDistance = routeData.pois.map((poi) =>
  nearestRouteDistanceMeters(routeData.track, routeData.distances, poi.lat, poi.lon)
);

// Same idea for turn-by-turn cues, used by the follow-mode nav banner.
const cueRouteDistance = routeData.cues.map((cue) =>
  nearestRouteDistanceMeters(routeData.track, routeData.distances, cue.lat, cue.lon)
);

const CUE_ICONS = {
  Left: '⬅️',
  Right: '➡️',
  Straight: '⬆️',
  'Slight Left': '↖️',
  'Slight Right': '↗️',
  'Sharp Left': '↙️',
  'Sharp Right': '↘️',
  Uturn: '↩️',
  'U-turn': '↩️',
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Position marker used by the elevation-profile hover sync.
const hoverMarker = L.circleMarker([0, 0], {
  radius: 7,
  color: '#fff',
  weight: 2,
  fillColor: '#ff5a1f',
  fillOpacity: 1,
}).addTo(map);
hoverMarker.setStyle({ opacity: 0, fillOpacity: 0 });
function showHoverAt(idx) {
  const [lat, lon] = routeData.track[idx];
  hoverMarker.setLatLng([lat, lon]);
  hoverMarker.setStyle({ opacity: 1, fillOpacity: 1 });
}

// ---------- Panels ----------
const panels = ['panel-pois', 'panel-elevation', 'panel-offline'];
function openPanel(id) {
  for (const p of panels) document.getElementById(p).hidden = p !== id;
}
function closeAllPanels() {
  for (const p of panels) document.getElementById(p).hidden = true;
}

document.getElementById('btn-pois').addEventListener('click', () => {
  const el = document.getElementById('panel-pois');
  el.hidden ? openPanel('panel-pois') : closeAllPanels();
});
document.getElementById('btn-elevation').addEventListener('click', () => {
  const el = document.getElementById('panel-elevation');
  el.hidden ? openPanel('panel-elevation') : closeAllPanels();
});
document.getElementById('btn-offline').addEventListener('click', () => {
  const el = document.getElementById('panel-offline');
  el.hidden ? openPanel('panel-offline') : closeAllPanels();
});
document.querySelectorAll('.panel-close').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.close).hidden = true;
  });
});

// ---------- POI list & filters ----------
const poiList = document.getElementById('poi-list');
const poiFilters = document.getElementById('poi-filters');
const poiSubtitle = document.getElementById('poi-subtitle');
const activeCategories = new Set(allCategories().map((c) => c.id));

// Set from the location tracker's onPosition callback; null while location
// tracking is off, in which case the list just shows the whole route in order.
let currentMileageMeters = null;

function renderPoiFilters() {
  poiFilters.innerHTML = '';
  for (const cat of allCategories()) {
    const btn = document.createElement('button');
    btn.className = 'filter-chip active';
    btn.textContent = `${cat.emoji} ${cat.label}`;
    btn.addEventListener('click', () => {
      if (activeCategories.has(cat.id)) {
        activeCategories.delete(cat.id);
        btn.classList.remove('active');
      } else {
        activeCategories.add(cat.id);
        btn.classList.add('active');
      }
      applyFilters();
    });
    poiFilters.appendChild(btn);
  }
}

function applyFilters() {
  poiMarkers.forEach((m) => {
    const show = activeCategories.has(m.category);
    const el = m.getElement();
    if (el) el.style.display = show ? '' : 'none';
  });
  renderPoiListItems();
}

function renderPoiListItems() {
  poiList.innerHTML = '';

  const tracking = currentMileageMeters != null;
  if (tracking) {
    const mi = metersToMiles(currentMileageMeters).toFixed(1);
    const total = metersToMiles(routeData.totalDistanceMeters).toFixed(1);
    poiSubtitle.textContent = `You're at mile ${mi} of ${total} — showing what's ahead`;
  } else {
    poiSubtitle.textContent = 'Sorted by route order, start to finish';
  }

  const rows = routeData.pois
    .map((poi, i) => ({ poi, i, cat: categorize(poi.name), dist: poiRouteDistance[i] }))
    .filter((row) => activeCategories.has(row.cat.id))
    .filter((row) => !tracking || row.dist >= currentMileageMeters)
    .sort((a, b) => a.dist - b.dist);

  for (const { poi, i, cat, dist } of rows) {
    const li = document.createElement('li');
    const distLabel = tracking
      ? `${metersToMiles(dist - currentMileageMeters).toFixed(1)} mi`
      : `mile ${metersToMiles(dist).toFixed(1)}`;
    li.innerHTML =
      `<span class="poi-emoji">${cat.emoji}</span> <span class="poi-name">${escapeHtml(poi.name)}</span>` +
      `<span class="poi-dist">${distLabel}</span>`;
    li.addEventListener('click', () => {
      map.setView([poi.lat, poi.lon], 15);
      poiMarkers[i].openPopup();
      closeAllPanels();
    });
    poiList.appendChild(li);
  }
}

renderPoiFilters();
renderPoiListItems();

// ---------- Elevation profile ----------
const totalMiles = metersToMiles(routeData.totalDistanceMeters).toFixed(1);
document.getElementById('route-stats').textContent =
  `${totalMiles} mi · +${routeData.elevationGainMeters}m / -${routeData.elevationLossMeters}m`;

renderElevationProfile(document.getElementById('elevation-chart'), {
  track: routeData.track,
  distances: routeData.distances,
  onHover: showHoverAt,
});

// ---------- Offline tile download ----------
// Fixed corridor covering the whole route from overview (z12) down to
// street-level (z16) detail. Not user-configurable on purpose — one button,
// one sensible default, no decisions to get wrong before a trip.
const OFFLINE_ZOOMS = [12, 13, 14, 15, 16];
const OFFLINE_BUFFER_TILES = 1;
const OFFLINE_SAMPLE_SPACING_METERS = 200;

const offlineStatus = document.getElementById('offline-status');
const progressWrap = document.getElementById('offline-progress');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const btnDownload = document.getElementById('btn-download');
const btnCancel = document.getElementById('btn-cancel');
const btnClearCache = document.getElementById('btn-clear-cache');

const BYTES_PER_TILE_ESTIMATE = 22 * 1024; // rough average for a 256px satellite JPEG tile

async function refreshCacheStatus() {
  const count = await getCachedTileCount();
  const meta = JSON.parse(localStorage.getItem('offlineDownloadMeta') || 'null');
  if (count === 0) {
    offlineStatus.textContent = 'No offline tiles cached yet.';
  } else {
    const when = meta?.timestamp ? new Date(meta.timestamp).toLocaleString() : 'unknown time';
    const complete = meta?.failed ? ` (${meta.failed} tiles failed — try downloading again)` : '';
    offlineStatus.textContent = `${count.toLocaleString()} tiles cached (~${(
      (count * BYTES_PER_TILE_ESTIMATE) /
      1024 /
      1024
    ).toFixed(0)} MB). Last download: ${when}.${complete}`;
  }
}
refreshCacheStatus();

function currentTileList() {
  return computeCorridorTiles(
    routeData.track,
    routeData.distances,
    OFFLINE_ZOOMS,
    OFFLINE_BUFFER_TILES,
    OFFLINE_SAMPLE_SPACING_METERS
  );
}

let activeDownload = null;

btnDownload.addEventListener('click', () => {
  const tiles = currentTileList();

  btnDownload.hidden = true;
  btnCancel.hidden = false;
  progressWrap.hidden = false;
  progressFill.style.width = '0%';
  progressText.textContent = `0 / ${tiles.length}`;

  activeDownload = downloadTiles(tiles, {
    concurrency: 6,
    onProgress: ({ done, failed, total }) => {
      const pct = total ? Math.round((done / total) * 100) : 100;
      progressFill.style.width = pct + '%';
      progressText.textContent = `${done} / ${total}${failed ? ` (${failed} failed)` : ''}`;
    },
  });

  activeDownload.promise.then(({ cancelled, failed }) => {
    btnDownload.hidden = false;
    btnCancel.hidden = true;
    progressWrap.hidden = true;
    activeDownload = null;
    if (!cancelled) {
      localStorage.setItem(
        'offlineDownloadMeta',
        JSON.stringify({ timestamp: Date.now(), zooms: OFFLINE_ZOOMS, tileCount: tiles.length, failed })
      );
    }
    refreshCacheStatus();
  });
});

btnCancel.addEventListener('click', () => {
  if (activeDownload) activeDownload.cancel();
});

btnClearCache.addEventListener('click', async () => {
  await clearTileCache();
  localStorage.removeItem('offlineDownloadMeta');
  refreshCacheStatus();
});

// ---------- Current location + heading ----------
const btnLocate = document.getElementById('btn-locate');
const locateStatus = document.getElementById('locate-status');
const btnFollow = document.getElementById('btn-follow');
const navBanner = document.getElementById('nav-banner');
const navBannerIcon = document.getElementById('nav-banner-icon');
const navBannerText = document.getElementById('nav-banner-text');
const navBannerDist = document.getElementById('nav-banner-dist');

const followMode = createFollowMode(map, {
  mapEl: document.getElementById('map'),
  tiltWrapEl: document.getElementById('map-tilt-wrap'),
});

const topBar = document.getElementById('top-bar');
// The top bar's row of buttons wraps to two lines on narrow phones, so its
// actual rendered height varies — read it directly rather than assuming a
// fixed offset, or the banner ends up hidden behind the second row.
function positionNavBanner() {
  navBanner.style.top = `${topBar.getBoundingClientRect().bottom + 8}px`;
}
window.addEventListener('resize', positionNavBanner);

function updateNavBanner() {
  if (!followMode.isActive() || currentMileageMeters == null) {
    navBanner.hidden = true;
    return;
  }
  let nextIdx = -1;
  let nextDist = Infinity;
  for (let i = 0; i < cueRouteDistance.length; i++) {
    const d = cueRouteDistance[i];
    if (d >= currentMileageMeters && d < nextDist) {
      nextDist = d;
      nextIdx = i;
    }
  }
  if (nextIdx === -1) {
    navBanner.hidden = true;
    return;
  }
  const cue = routeData.cues[nextIdx];
  navBannerIcon.textContent = CUE_ICONS[cue.direction] ?? '⬆️';
  navBannerText.textContent = cue.instruction;
  navBannerDist.textContent = `${metersToMiles(nextDist - currentMileageMeters).toFixed(1)} mi`;
  positionNavBanner();
  navBanner.hidden = false;
}

function setFollowActive(active) {
  if (active) {
    const latlng = locationTracker.getLatLng();
    followMode.enable(latlng?.lat, latlng?.lng, locationTracker.getHeading());
  } else {
    followMode.disable();
  }
  btnFollow.classList.toggle('active', active);
  updateNavBanner();
}

const locationTracker = createLocationTracker(map, {
  onStatus: ({ tracking, following, error, headingState }) => {
    btnLocate.classList.toggle('active', tracking && following);
    btnLocate.classList.toggle('stale', tracking && !following);
    if (error) {
      locateStatus.hidden = false;
      locateStatus.textContent = error;
    } else if (tracking && headingState === 'denied') {
      locateStatus.hidden = false;
      locateStatus.textContent =
        'Location is on, but compass access was denied so there\'s no heading arrow. ' +
        'Check Settings → Safari → Motion & Orientation Access is on, then reload and tap Locate again.';
    } else {
      locateStatus.hidden = true;
    }
    btnFollow.disabled = !tracking;
    if (!tracking) {
      if (followMode.isActive()) setFollowActive(false);
      if (currentMileageMeters != null) {
        currentMileageMeters = null;
        renderPoiListItems();
      }
    }
  },
  onPosition: ({ lat, lon }) => {
    currentMileageMeters = nearestRouteDistanceMeters(routeData.track, routeData.distances, lat, lon);
    renderPoiListItems();
    updateNavBanner();
    if (followMode.isActive()) followMode.updatePosition(lat, lon, locationTracker.getHeading());
  },
  onHeading: (headingDeg) => {
    if (followMode.isActive()) followMode.updateHeading(headingDeg);
  },
});

btnLocate.addEventListener('click', () => {
  if (!locationTracker.isActive()) {
    locationTracker.start();
  } else if (!locationTracker.isFollowing()) {
    locationTracker.recenter();
  } else {
    locationTracker.stop();
  }
});

btnFollow.addEventListener('click', () => {
  if (btnFollow.disabled) return;
  setFollowActive(!followMode.isActive());
});

// ---------- PWA install / service worker ----------
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}

// iOS Safari never fires `beforeinstallprompt` — there is no JS install API
// at all. The only way to detect "not installed yet" there is to check
// `navigator.standalone`, and the only way to install is the manual
// Share -> Add to Home Screen flow, so that's what we point at.
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone =
  window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
const installHint = document.getElementById('install-hint');
if (isIos && !isStandalone) {
  installHint.textContent = 'Install this app: tap Share, then "Add to Home Screen"';
  installHint.hidden = false;
} else {
  window.addEventListener('beforeinstallprompt', () => {
    installHint.textContent = 'Install this app: browser menu → "Add to Home Screen"';
    installHint.hidden = false;
  });
}
