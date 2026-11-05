// Converts Garmin Connect course exports (.fit) in source-data/routes/ into the
// same compact JSON the app bundles for the GPX route, one file per course.
// A FIT course has `record` messages (the track) and optional `course_point`
// messages (named waypoints such as "Water"). Garmin courses carry no
// turn-by-turn cue text here, so `cues` is empty and the nav banner simply
// stays hidden for these routes.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Decoder, Stream } from '@garmin/fitsdk';
import { trackStats, writeRoute } from './route-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fitDir = path.join(__dirname, '..', 'source-data', 'routes');

const SEMICIRCLES_TO_DEG = 180 / 2 ** 31;
const toDeg = (sc) => sc * SEMICIRCLES_TO_DEG;
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

for (const file of readdirSync(fitDir).filter((f) => f.toLowerCase().endsWith('.fit')).sort()) {
  const id = path.basename(file, path.extname(file));
  const stream = Stream.fromBuffer(readFileSync(path.join(fitDir, file)));
  const decoder = new Decoder(stream);
  if (!decoder.isFIT() || !decoder.checkIntegrity()) {
    throw new Error(`${file}: not a valid FIT file`);
  }
  const { messages, errors } = decoder.read();
  if (errors.length) throw new Error(`${file}: FIT decode errors: ${errors.join('; ')}`);

  const name = messages.courseMesgs?.[0]?.name || id;

  const track = [];
  for (const r of messages.recordMesgs ?? []) {
    if (r.positionLat == null || r.positionLong == null) continue;
    const ele = r.enhancedAltitude ?? r.altitude ?? 0;
    track.push([round(toDeg(r.positionLat), 6), round(toDeg(r.positionLong), 6), round(ele, 1)]);
  }
  if (track.length < 2) throw new Error(`${file}: no track points found`);

  const pois = (messages.coursePointMesgs ?? [])
    .filter((p) => p.positionLat != null && p.positionLong != null)
    .map((p) => ({
      lat: round(toDeg(p.positionLat), 6),
      lon: round(toDeg(p.positionLong), 6),
      name: p.name || String(p.type ?? 'Point'),
      desc: '',
    }));

  writeRoute({
    id,
    name,
    source: 'Garmin Connect course (.fit)',
    track,
    ...trackStats(track),
    pois,
    cues: [],
  });
}
