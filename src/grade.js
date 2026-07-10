// Shared grade (%) computation, used by both the elevation chart and the
// grade-colored track on the map. Consumer GPX elevation is noisy enough
// (recorded GPS altitude error, not distance error) that differencing raw
// or lightly resampled points produces swings up to +-35%, nothing like a
// real road. Resampling to a longer, consistent run plus a moving-average
// smoothing pass on elevation brings that down to a believable +-10-15%
// range for this kind of gravel mountain route.
export const GRADE_SEGMENT_METERS = 400;
export const SMOOTHING_WINDOW = 2; // +-2 resampled points = 5-point moving average

// Samples the track every `spacingMeters`, keeping each sample's original
// track index (not just its lat/lon/ele) so callers that need to draw the
// actual path between two samples — not just a straight line between them
// — can slice the raw track array.
export function resampleByDistance(track, distances, spacingMeters) {
  const samples = [];
  let nextAt = 0;
  for (let i = 0; i < track.length; i++) {
    if (distances[i] >= nextAt) {
      samples.push({ index: i, dist: distances[i], ele: track[i][2] });
      nextAt += spacingMeters;
    }
  }
  const lastIndex = track.length - 1;
  if (samples[samples.length - 1]?.index !== lastIndex) {
    samples.push({ index: lastIndex, dist: distances[lastIndex], ele: track[lastIndex][2] });
  }
  return samples;
}

export function smoothElevation(samples, window) {
  return samples.map((s, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(samples.length - 1, i + window); j++) {
      sum += samples[j].ele;
      count++;
    }
    return { index: s.index, dist: s.dist, ele: sum / count };
  });
}

// Returns one entry per gap between consecutive samples: the grade over
// that gap, plus the track-index range it spans (indexStart..indexEnd,
// inclusive) so callers can draw the exact path for that segment.
export function computeGrades(samples) {
  const grades = [];
  for (let i = 1; i < samples.length; i++) {
    const rise = samples[i].ele - samples[i - 1].ele;
    const run = samples[i].dist - samples[i - 1].dist;
    grades.push({
      dist: samples[i].dist,
      grade: run > 0 ? (rise / run) * 100 : 0,
      indexStart: samples[i - 1].index,
      indexEnd: samples[i].index,
    });
  }
  return grades;
}

export function gradeProfile(track, distances) {
  const samples = smoothElevation(resampleByDistance(track, distances, GRADE_SEGMENT_METERS), SMOOTHING_WINDOW);
  return computeGrades(samples);
}

// Diverging blue (descent) -> white (flat) -> red (climb) color scale for
// the track. +-12% saturates fully — a bit past this route's actual
// +11%/-13% range, so only its steepest moments hit full color.
const DESCENT_COLOR = [37, 99, 235]; // blue
const FLAT_COLOR = [255, 255, 255]; // white
const CLIMB_COLOR = [220, 38, 38]; // red
const MAX_ABS_GRADE = 12;

function lerpChannel(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function lerpColor(c1, c2, t) {
  return `rgb(${lerpChannel(c1[0], c2[0], t)}, ${lerpChannel(c1[1], c2[1], t)}, ${lerpChannel(c1[2], c2[2], t)})`;
}

export function gradeColor(gradePercent) {
  const t = Math.max(-1, Math.min(1, gradePercent / MAX_ABS_GRADE));
  return t < 0 ? lerpColor(DESCENT_COLOR, FLAT_COLOR, t + 1) : lerpColor(FLAT_COLOR, CLIMB_COLOR, t);
}
