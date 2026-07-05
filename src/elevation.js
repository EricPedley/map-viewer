// Lightweight SVG elevation profile (no charting library). Draws the
// distance/elevation curve and reports the hovered track index so the map
// can show a synced position marker.
export function renderElevationProfile(container, { track, distances, onHover }) {
  const width = 1000;
  const height = 160;
  const padding = { top: 10, right: 10, bottom: 22, left: 42 };

  const elevations = track.map((p) => p[2]);
  const minEle = Math.min(...elevations);
  const maxEle = Math.max(...elevations);
  const maxDist = distances[distances.length - 1];

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const xFor = (d) => padding.left + (d / maxDist) * plotW;
  const yFor = (e) => padding.top + plotH - ((e - minEle) / (maxEle - minEle || 1)) * plotH;

  // Downsample for a smooth, light-weight path (elevation profile doesn't
  // need per-GPX-point precision to look right).
  const step = Math.max(1, Math.floor(track.length / 600));
  let d = '';
  for (let i = 0; i < track.length; i += step) {
    const x = xFor(distances[i]);
    const y = yFor(elevations[i]);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  }

  const areaD = d + `L${xFor(maxDist).toFixed(1)},${(padding.top + plotH).toFixed(1)} L${padding.left},${(padding.top + plotH).toFixed(1)} Z`;

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="elevation-svg">
      <path d="${areaD}" class="elevation-area"></path>
      <path d="${d}" class="elevation-line"></path>
      <line class="elevation-cursor" x1="0" y1="${padding.top}" x2="0" y2="${padding.top + plotH}" style="display:none"></line>
      <text x="${padding.left}" y="${padding.top + 10}" class="elevation-label">${Math.round(maxEle)}m</text>
      <text x="${padding.left}" y="${padding.top + plotH}" class="elevation-label">${Math.round(minEle)}m</text>
    </svg>
    <div class="elevation-readout"></div>
  `;

  const svg = container.querySelector('svg');
  const cursor = container.querySelector('.elevation-cursor');
  const readout = container.querySelector('.elevation-readout');

  function handleMove(clientX) {
    const rect = svg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const dist = frac * maxDist;
    // binary search nearest index in distances
    let lo = 0, hi = distances.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distances[mid] < dist) lo = mid + 1; else hi = mid;
    }
    const idx = lo;
    const x = xFor(distances[idx]);
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    cursor.style.display = '';
    readout.textContent = `${(distances[idx] / 1000).toFixed(1)} km — ${Math.round(track[idx][2])} m`;
    if (onHover) onHover(idx);
  }

  svg.addEventListener('mousemove', (e) => handleMove(e.clientX));
  svg.addEventListener('touchmove', (e) => {
    if (e.touches[0]) handleMove(e.touches[0].clientX);
  }, { passive: true });
  svg.addEventListener('mouseleave', () => {
    cursor.style.display = 'none';
    readout.textContent = '';
  });
}
