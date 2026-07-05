import { metersToMiles } from './projection.js';

// Percent-grade profile (rise/run * 100) rather than absolute elevation —
// what matters for a bike route is how steep the next climb is, not the
// absolute altitude. Consumer GPX elevation is noisy enough (recorded GPS
// altitude error, not distance error) that differencing raw or lightly
// resampled points produces swings up to +-35%, nothing like a real road.
// Resampling to a longer, consistent run plus a moving-average smoothing
// pass on elevation brings that down to a believable +-10-15% range for
// this kind of gravel mountain route.
const GRADE_SEGMENT_METERS = 400;
const SMOOTHING_WINDOW = 2; // +-2 resampled points = 5-point moving average

function resampleByDistance(track, distances, spacingMeters) {
  const samples = [];
  let nextAt = 0;
  for (let i = 0; i < track.length; i++) {
    if (distances[i] >= nextAt) {
      samples.push({ dist: distances[i], ele: track[i][2] });
      nextAt += spacingMeters;
    }
  }
  return samples;
}

function smoothElevation(samples, window) {
  return samples.map((s, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(samples.length - 1, i + window); j++) {
      sum += samples[j].ele;
      count++;
    }
    return { dist: s.dist, ele: sum / count };
  });
}

function computeGrades(samples) {
  const grades = [];
  for (let i = 1; i < samples.length; i++) {
    const rise = samples[i].ele - samples[i - 1].ele;
    const run = samples[i].dist - samples[i - 1].dist;
    grades.push({ dist: samples[i].dist, grade: run > 0 ? (rise / run) * 100 : 0 });
  }
  return grades;
}

export function renderElevationProfile(container, { track, distances, onHover }) {
  const width = 1000;
  const height = 160;
  const padding = { top: 10, right: 10, bottom: 22, left: 42 };

  const samples = smoothElevation(resampleByDistance(track, distances, GRADE_SEGMENT_METERS), SMOOTHING_WINDOW);
  const grades = computeGrades(samples);
  const maxDist = distances[distances.length - 1];

  const gradeValues = grades.map((g) => g.grade);
  const maxGrade = Math.max(1, ...gradeValues);
  const minGrade = Math.min(-1, ...gradeValues);

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const xFor = (d) => padding.left + (d / maxDist) * plotW;
  const yFor = (g) => padding.top + plotH - ((g - minGrade) / (maxGrade - minGrade)) * plotH;
  const zeroY = yFor(0);

  let lineD = '';
  grades.forEach((g, i) => {
    const x = xFor(g.dist);
    const y = yFor(g.grade);
    lineD += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  });
  const areaD =
    `M${xFor(0).toFixed(1)},${zeroY.toFixed(1)} ` +
    grades.map((g) => `L${xFor(g.dist).toFixed(1)},${yFor(g.grade).toFixed(1)}`).join(' ') +
    ` L${xFor(maxDist).toFixed(1)},${zeroY.toFixed(1)} Z`;

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="elevation-svg">
      <path d="${areaD}" class="elevation-area"></path>
      <line class="elevation-zero" x1="${padding.left}" y1="${zeroY.toFixed(1)}" x2="${(width - padding.right).toFixed(1)}" y2="${zeroY.toFixed(1)}"></line>
      <path d="${lineD}" class="elevation-line"></path>
      <line class="elevation-cursor" x1="0" y1="${padding.top}" x2="0" y2="${padding.top + plotH}" style="display:none"></line>
      <text x="${padding.left}" y="${padding.top + 10}" class="elevation-label">${maxGrade.toFixed(0)}%</text>
      <text x="${padding.left}" y="${padding.top + plotH}" class="elevation-label">${minGrade.toFixed(0)}%</text>
    </svg>
    <div class="elevation-readout"></div>
  `;

  const svg = container.querySelector('svg');
  const cursor = container.querySelector('.elevation-cursor');
  const readout = container.querySelector('.elevation-readout');

  function nearestTrackIndex(dist) {
    let lo = 0,
      hi = distances.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distances[mid] < dist) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function gradeAt(dist) {
    let lo = 0,
      hi = grades.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (grades[mid].dist < dist) lo = mid + 1;
      else hi = mid;
    }
    return grades[lo]?.grade ?? 0;
  }

  function handleMove(clientX) {
    const rect = svg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const dist = frac * maxDist;
    const idx = nearestTrackIndex(dist);
    const x = xFor(distances[idx]);
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    cursor.style.display = '';
    const miles = metersToMiles(distances[idx]).toFixed(1);
    const ele = Math.round(track[idx][2]);
    const grade = gradeAt(distances[idx]);
    readout.textContent = `${miles} mi — ${ele} m — ${grade > 0 ? '+' : ''}${grade.toFixed(0)}% grade`;
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
