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

// ---------- Map setup ----------
const map = L.map('map', { zoomControl: false, attributionControl: true });
L.control.zoom({ position: 'bottomright' }).addTo(map);

const satellite = L.tileLayer(SATELLITE_URL_TEMPLATE, {
  maxZoom: 18,
  maxNativeZoom: 17,
  attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
}).addTo(map);

const latlngs = routeData.track.map(([lat, lon]) => [lat, lon]);
const trackLine = L.polyline(latlngs, { color: '#ff5a1f', weight: 4, opacity: 0.9 }).addTo(map);
map.fitBounds(trackLine.getBounds(), { padding: [24, 24] });

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
const activeCategories = new Set(allCategories().map((c) => c.id));

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
  routeData.pois.forEach((poi, i) => {
    const cat = categorize(poi.name);
    if (!activeCategories.has(cat.id)) return;
    const li = document.createElement('li');
    li.innerHTML = `<span class="poi-emoji">${cat.emoji}</span> <span>${escapeHtml(poi.name)}</span>`;
    li.addEventListener('click', () => {
      map.setView([poi.lat, poi.lon], 15);
      poiMarkers[i].openPopup();
      closeAllPanels();
    });
    poiList.appendChild(li);
  });
}

renderPoiFilters();
renderPoiListItems();

// ---------- Elevation profile ----------
const km = (routeData.totalDistanceMeters / 1000).toFixed(1);
document.getElementById('route-stats').textContent =
  `${km} km · +${routeData.elevationGainMeters}m / -${routeData.elevationLossMeters}m`;

renderElevationProfile(document.getElementById('elevation-chart'), {
  track: routeData.track,
  distances: routeData.distances,
  onHover: showHoverAt,
});

// ---------- Offline tile download ----------
const ZOOM_LEVELS = [12, 13, 14, 15, 16];
const zoomChecksEl = document.getElementById('zoom-checks');
ZOOM_LEVELS.forEach((z) => {
  const label = document.createElement('label');
  label.className = 'zoom-check';
  const checked = z >= 13 && z <= 15;
  label.innerHTML = `<input type="checkbox" value="${z}" ${checked ? 'checked' : ''}/> ${z}`;
  zoomChecksEl.appendChild(label);
});

const bufferRange = document.getElementById('buffer-range');
const bufferValue = document.getElementById('buffer-value');
const BUFFER_LABELS = ['Route line only', 'Narrow', 'Medium', 'Wide'];
function updateBufferLabel() {
  bufferValue.textContent = BUFFER_LABELS[bufferRange.value];
}
bufferRange.addEventListener('input', updateBufferLabel);
updateBufferLabel();

function selectedZooms() {
  return [...zoomChecksEl.querySelectorAll('input:checked')].map((el) => Number(el.value));
}

const offlineStatus = document.getElementById('offline-status');
const progressWrap = document.getElementById('offline-progress');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const btnDownload = document.getElementById('btn-download');
const btnCancel = document.getElementById('btn-cancel');
const btnEstimate = document.getElementById('btn-estimate');
const btnClearCache = document.getElementById('btn-clear-cache');

const BYTES_PER_TILE_ESTIMATE = 22 * 1024; // rough average for a 256px satellite JPEG tile

async function refreshCacheStatus() {
  const count = await getCachedTileCount();
  const meta = JSON.parse(localStorage.getItem('offlineDownloadMeta') || 'null');
  if (count === 0) {
    offlineStatus.textContent = 'No offline tiles cached yet.';
  } else {
    const when = meta?.timestamp ? new Date(meta.timestamp).toLocaleString() : 'unknown time';
    offlineStatus.textContent = `${count.toLocaleString()} tiles cached (~${(
      (count * BYTES_PER_TILE_ESTIMATE) /
      1024 /
      1024
    ).toFixed(0)} MB). Last download: ${when}.`;
  }
}
refreshCacheStatus();

function currentTileList() {
  const zooms = selectedZooms();
  const buffer = Number(bufferRange.value);
  const spacing = 250; // meters between corridor sample points
  return computeCorridorTiles(routeData.track, routeData.distances, zooms, buffer, spacing);
}

btnEstimate.addEventListener('click', () => {
  const zooms = selectedZooms();
  if (zooms.length === 0) {
    offlineStatus.textContent = 'Pick at least one zoom level first.';
    return;
  }
  const tiles = currentTileList();
  const mb = (tiles.length * BYTES_PER_TILE_ESTIMATE) / 1024 / 1024;
  offlineStatus.textContent = `Estimate: ${tiles.length.toLocaleString()} tiles, ~${mb.toFixed(
    0
  )} MB. Tap Download to fetch them now.`;
});

let activeDownload = null;

btnDownload.addEventListener('click', () => {
  const zooms = selectedZooms();
  if (zooms.length === 0) {
    offlineStatus.textContent = 'Pick at least one zoom level first.';
    return;
  }
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
        JSON.stringify({ timestamp: Date.now(), zooms, tileCount: tiles.length, failed })
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

// ---------- PWA install / service worker ----------
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  document.getElementById('install-hint').hidden = false;
});
