// Derives turn-by-turn cues and convenience-store POIs for a route from raw
// OpenStreetMap data (as returned by the Overpass API). Pure functions, no
// network — scripts/fetch-osm.mjs does the fetching, and the unit tests feed
// this synthetic data.
//
// How the turn cues work (a "map-matching-lite" approach):
//   1. Build a road graph from the OSM ways near the route. A node that
//      three or more road segments meet at is a junction.
//   2. Find every place the route passes through a junction (a route can pass
//      the same junction twice, e.g. a loop that retraces a road).
//   3. At each pass, compare the route's heading just before and just after
//      the junction. That gives the turn angle (right = positive).
//   4. Only emit a cue if there was a real decision: another road branches off
//      that the rider didn't take. Going straight through a crossroads gets
//      no cue; a fork where the route keeps to one branch gets "Keep left/right".
//   5. Name the road the rider ends up on ("onto Sunset Rd").
//   6. Roundabouts are collapsed into a single "take the Nth exit" cue.

const METERS_PER_DEG = 111320;
const RAD = Math.PI / 180;

// Roads a bicycle could reasonably be routed along. Footways/steps/etc. are
// excluded so they don't create phantom "alternatives" at junctions.
const EXCLUDED_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'footway', 'steps', 'pedestrian', 'corridor', 'construction',
  'proposed', 'razed', 'abandoned', 'platform', 'elevator', 'bus_guideway', 'raceway', 'escalator',
]);
const EXCLUDED_SERVICES = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access']);
const UNPAVED_SURFACES = new Set([
  'unpaved', 'gravel', 'fine_gravel', 'dirt', 'compacted', 'ground', 'earth', 'sand', 'grass', 'mud', 'pebblestone',
]);

export function isRoutable(tags = {}) {
  const hw = tags.highway;
  if (!hw || EXCLUDED_HIGHWAYS.has(hw)) return false;
  if (hw === 'service' && EXCLUDED_SERVICES.has(tags.service)) return false;
  if ((tags.access === 'private' || tags.access === 'no') && !['yes', 'designated'].includes(tags.bicycle)) return false;
  return true;
}

// ---------- geometry ----------

export function makeProjector(track) {
  let lat0 = 0;
  let lon0 = 0;
  for (const [lat, lon] of track) {
    lat0 += lat;
    lon0 += lon;
  }
  lat0 /= track.length;
  lon0 /= track.length;
  const cos = Math.cos(lat0 * RAD);
  return {
    toXY: (lat, lon) => [(lon - lon0) * cos * METERS_PER_DEG, (lat - lat0) * METERS_PER_DEG],
    toLatLon: (x, y) => [lat0 + y / METERS_PER_DEG, lon0 + x / (cos * METERS_PER_DEG)],
  };
}

// Compass bearing in degrees (0 = north, clockwise) of the vector (dx, dy).
const bearing = (dx, dy) => (Math.atan2(dx, dy) / RAD + 360) % 360;
// Signed smallest difference from bearing a to bearing b: + means turning right.
const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { dist: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

// Douglas-Peucker simplification of [lat, lon] points; used to keep the
// Overpass query small. toleranceMeters is the max deviation allowed.
export function simplifyTrack(track, toleranceMeters) {
  const proj = makeProjector(track);
  const pts = track.map(([lat, lon]) => proj.toXY(lat, lon));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let worst = -1;
    let worstDist = 0;
    for (let i = lo + 1; i < hi; i++) {
      const { dist } = segmentDistance(pts[i][0], pts[i][1], pts[lo][0], pts[lo][1], pts[hi][0], pts[hi][1]);
      if (dist > worstDist) {
        worstDist = dist;
        worst = i;
      }
    }
    if (worst !== -1 && worstDist > toleranceMeters) {
      keep[worst] = 1;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return track.filter((_, i) => keep[i]);
}

// A spatial hash over the track's segments so "which segments are near this
// point" doesn't scan the whole route for every junction.
function buildSegmentIndex(pts, cell) {
  const grid = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const x0 = Math.floor(Math.min(ax, bx) / cell);
    const x1 = Math.floor(Math.max(ax, bx) / cell);
    const y0 = Math.floor(Math.min(ay, by) / cell);
    const y1 = Math.floor(Math.max(ay, by) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  }
  return {
    near(x, y) {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const out = new Set();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const i of grid.get(key(cx + dx, cy + dy)) ?? []) out.add(i);
        }
      }
      return out;
    },
  };
}

// ---------- road graph ----------

function buildGraph(ways, proj) {
  const nodes = new Map();
  const nodeFor = (id, g) => {
    let n = nodes.get(id);
    if (!n) {
      const [x, y] = proj.toXY(g.lat, g.lon);
      n = { id, lat: g.lat, lon: g.lon, x, y, nbrs: new Map(), roundabout: false };
      nodes.set(id, n);
    }
    return n;
  };
  for (const way of ways) {
    if (!isRoutable(way.tags) || !way.nodes || !way.geometry) continue;
    const roundabout = way.tags.junction === 'roundabout';
    let prev = null;
    for (let i = 0; i < way.nodes.length; i++) {
      const n = nodeFor(way.nodes[i], way.geometry[i]);
      if (roundabout) n.roundabout = true;
      if (prev && prev !== n) {
        if (!prev.nbrs.has(n.id)) prev.nbrs.set(n.id, way);
        if (!n.nbrs.has(prev.id)) n.nbrs.set(prev.id, way);
      }
      prev = n;
    }
  }
  return nodes;
}

// The roads leaving junction `j`, each with a compass bearing measured to a
// point ~20m along it (walking through plain mid-road nodes), so a tiny first
// segment near the junction doesn't distort the direction.
function edgesAt(j, nodes) {
  const edges = [];
  for (const [nbrId, way] of j.nbrs) {
    let prev = j;
    let cur = nodes.get(nbrId);
    let hops = 0;
    while (Math.hypot(cur.x - j.x, cur.y - j.y) < 20 && cur.nbrs.size === 2 && hops++ < 10) {
      const nextId = [...cur.nbrs.keys()].find((id) => id !== prev.id);
      prev = cur;
      cur = nodes.get(nextId);
    }
    edges.push({
      nbrId,
      way,
      bearing: bearing(cur.x - j.x, cur.y - j.y),
      roundabout: way.tags.junction === 'roundabout',
    });
  }
  return edges;
}

// ---------- turn cues ----------

const LOOKAROUND_METERS = 25;
const MAX_JUNCTION_SNAP_METERS = 15;
const MERGE_CUES_WITHIN_METERS = 30;
const ROUNDABOUT_GROUP_GAP_METERS = 100;

function directionFor(angle) {
  const abs = Math.abs(angle);
  const right = angle > 0;
  if (abs >= 165) return 'Uturn';
  if (abs >= 120) return right ? 'Sharp Right' : 'Sharp Left';
  if (abs >= 45) return right ? 'Right' : 'Left';
  return right ? 'Slight Right' : 'Slight Left';
}

export function describeWay(tags = {}) {
  if (tags.name && tags.ref) return `${tags.name}, ${tags.ref}`;
  if (tags.name || tags.ref) return tags.name || tags.ref;
  switch (tags.highway) {
    case 'cycleway': return 'bike path';
    case 'path': return 'trail';
    case 'bridleway': return 'trail';
    case 'track': return 'dirt road';
    case 'service': return 'service road';
    default:
      return UNPAVED_SURFACES.has(tags.surface) ? 'dirt road' : null;
  }
}

const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

function instructionFor(direction, kind, wayName, exitNumber) {
  const onto = wayName ? ` onto ${wayName}` : '';
  if (kind === 'roundabout') return `At the roundabout, take the ${ORDINAL[exitNumber] ?? exitNumber + 'th'} exit${onto}`;
  if (kind === 'fork') return `Keep ${direction === 'Slight Left' ? 'left' : 'right'}${onto}`;
  switch (direction) {
    case 'Left': return `Turn left${onto}`;
    case 'Right': return `Turn right${onto}`;
    case 'Slight Left': return `Turn slight left${onto}`;
    case 'Slight Right': return `Turn slight right${onto}`;
    case 'Sharp Left': return `Turn sharp left${onto}`;
    case 'Sharp Right': return `Turn sharp right${onto}`;
    case 'Uturn': return 'Make a U-turn';
    default: return `Continue${onto}`;
  }
}

/**
 * @param {number[][]} track   [lat, lon, ele] points
 * @param {number[]} distances cumulative meters, same length as track
 * @param {object[]} ways      Overpass ways: { id, tags, nodes: [id], geometry: [{lat, lon}] }
 * @returns {{lat, lon, direction, instruction, dist}[]} cues in route order
 */
export function deriveTurnCues(track, distances, ways) {
  const proj = makeProjector(track);
  const pts = track.map(([lat, lon]) => proj.toXY(lat, lon));
  const total = distances[distances.length - 1];
  const segIndex = buildSegmentIndex(pts, 40);
  const nodes = buildGraph(ways, proj);

  // Point `s` meters along the route, interpolated between track points.
  const pointAt = (s) => {
    const target = Math.max(0, Math.min(total, s));
    let lo = 0;
    let hi = distances.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distances[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return pts[0];
    const span = distances[lo] - distances[lo - 1] || 1;
    const t = (target - distances[lo - 1]) / span;
    return [pts[lo - 1][0] + t * (pts[lo][0] - pts[lo - 1][0]), pts[lo - 1][1] + t * (pts[lo][1] - pts[lo - 1][1])];
  };

  // 1) Every pass of the route through a junction.
  const passes = [];
  for (const j of nodes.values()) {
    if (j.nbrs.size < 3) continue;
    const hits = [];
    for (const i of segIndex.near(j.x, j.y)) {
      const { dist, t } = segmentDistance(j.x, j.y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (dist <= MAX_JUNCTION_SNAP_METERS) hits.push({ s: distances[i] + t * (distances[i + 1] - distances[i]), dist });
    }
    hits.sort((a, b) => a.s - b.s);
    // Hits close together along the route are one pass; keep the closest.
    let cluster = [];
    const flush = () => {
      if (!cluster.length) return;
      const best = cluster.reduce((a, b) => (b.dist < a.dist ? b : a));
      passes.push({ node: j, s: best.s });
      cluster = [];
    };
    for (const h of hits) {
      if (cluster.length && h.s - cluster[cluster.length - 1].s > 40) flush();
      cluster.push(h);
    }
    flush();
  }
  passes.sort((a, b) => a.s - b.s);

  // Heading in/out of a pass, and the road edges involved.
  const analyze = (pass) => {
    const p = pointAt(pass.s);
    const before = pointAt(pass.s - LOOKAROUND_METERS);
    const after = pointAt(pass.s + LOOKAROUND_METERS);
    const inB = bearing(p[0] - before[0], p[1] - before[1]);
    const outB = bearing(after[0] - p[0], after[1] - p[1]);
    const edges = edgesAt(pass.node, nodes);
    const nearest = (target) => edges.reduce((a, b) => (Math.abs(angleDiff(b.bearing, target)) < Math.abs(angleDiff(a.bearing, target)) ? b : a));
    const inEdge = nearest((inB + 180) % 360);
    const outEdge = nearest(outB);
    return { inB, outB, edges, inEdge, outEdge, angle: angleDiff(inB, outB) };
  };

  const cues = [];
  const usable = (s) => s >= LOOKAROUND_METERS && s <= total - LOOKAROUND_METERS;

  for (let k = 0; k < passes.length; k++) {
    const pass = passes[k];
    if (!usable(pass.s)) continue;

    // 2) Roundabout: swallow the whole run of roundabout nodes as one cue.
    if (pass.node.roundabout) {
      const group = [pass];
      while (k + 1 < passes.length && passes[k + 1].node.roundabout && passes[k + 1].s - group[group.length - 1].s < ROUNDABOUT_GROUP_GAP_METERS) {
        group.push(passes[++k]);
      }
      if (group.length > 1) {
        const first = analyze(group[0]);
        const last = analyze(group[group.length - 1]);
        // Exits passed on the way round = arms leaving the intermediate nodes.
        let exits = 1;
        for (const g of group.slice(1, -1)) {
          if (g.node.nbrs.size > 2 && edgesAt(g.node, nodes).some((e) => !e.roundabout)) exits++;
        }
        const angle = angleDiff(first.inB, last.outB);
        const direction = directionFor(angle);
        const name = describeWay(last.outEdge.way.tags);
        cues.push({
          s: group[0].s,
          absAngle: Math.abs(angle),
          lat: group[0].node.lat,
          lon: group[0].node.lon,
          direction: direction === 'Uturn' ? 'Uturn' : Math.abs(angle) < 45 ? 'Straight' : direction,
          instruction: instructionFor(direction, 'roundabout', name, exits),
        });
        continue;
      }
    }

    // 3) Ordinary junction.
    const a = analyze(pass);
    if (a.inEdge === a.outEdge && Math.abs(a.angle) < 165) continue; // can't tell which road is which
    const alts = a.edges.filter((e) => e !== a.inEdge && e !== a.outEdge);
    if (alts.length === 0) continue; // nothing to choose between — not a decision

    const abs = Math.abs(a.angle);
    let kind = 'turn';
    let direction;
    if (abs < 15) {
      // Roughly straight. Only worth a cue if the road forks and another
      // branch leaves at a similar heading (a "Y"), so the rider must pick.
      const fork = alts.find((e) => Math.abs(angleDiff(e.bearing, a.outEdge.bearing)) < 50);
      if (!fork) continue;
      kind = 'fork';
      // If the other branch peels off to the right of ours, we keep left.
      direction = angleDiff(a.outEdge.bearing, fork.bearing) > 0 ? 'Slight Left' : 'Slight Right';
    } else {
      direction = directionFor(a.angle);
    }

    cues.push({
      s: pass.s,
      absAngle: abs,
      lat: pass.node.lat,
      lon: pass.node.lon,
      direction,
      instruction: instructionFor(direction, kind, describeWay(a.outEdge.way.tags)),
    });
  }

  // 4) Compound intersections show up as several nearby junction nodes; keep
  // the most significant cue of each cluster.
  cues.sort((x, y) => x.s - y.s);
  const merged = [];
  for (const c of cues) {
    const last = merged[merged.length - 1];
    if (last && c.s - last.s < MERGE_CUES_WITHIN_METERS) {
      if (c.absAngle > last.absAngle) merged[merged.length - 1] = c;
    } else {
      merged.push(c);
    }
  }

  return merged.map((c) => ({
    lat: Math.round(c.lat * 1e6) / 1e6,
    lon: Math.round(c.lon * 1e6) / 1e6,
    direction: c.direction,
    instruction: c.instruction,
    dist: Math.round(c.s),
  }));
}

// ---------- side roads ----------
// The roads that branch off the route at its junctions but that the route
// doesn't use, clipped to a short stub so the map shows what's at each
// intersection without drawing the whole road network.

const SIDE_ROAD_LENGTH_METERS = 250;
// A stub counts as "the route's own road" if all of it stays this close to the
// track. Wide enough for GPS/OSM offset, narrow enough that a shallow fork
// (which drifts away from the route within a couple hundred meters) is kept.
const ON_ROUTE_METERS = 12;
const MIN_ON_ROUTE_CHECK_METERS = 20; // ignore the first bit, which is always near the junction

/**
 * @returns {[number, number][][]} polylines of [lat, lon] (5 decimals ≈ 1 m)
 */
export function deriveSideRoads(track, ways, { lengthMeters = SIDE_ROAD_LENGTH_METERS } = {}) {
  const proj = makeProjector(track);
  const pts = track.map(([lat, lon]) => proj.toXY(lat, lon));
  const segIndex = buildSegmentIndex(pts, 40);
  const nodes = buildGraph(ways, proj);

  // Distance from (x, y) to the route; Infinity when nothing is nearby.
  const distToRoute = (x, y) => {
    let best = Infinity;
    for (const i of segIndex.near(x, y)) {
      best = Math.min(best, segmentDistance(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]).dist);
    }
    return best;
  };

  // Cumulative distance along the route, for "the route's heading ~25 m
  // before/after this junction".
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const pointAt = (s) => {
    const target = Math.max(0, Math.min(total, s));
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return pts[0];
    const span = cum[lo] - cum[lo - 1] || 1;
    const t = (target - cum[lo - 1]) / span;
    return [pts[lo - 1][0] + t * (pts[lo][0] - pts[lo - 1][0]), pts[lo - 1][1] + t * (pts[lo][1] - pts[lo - 1][1])];
  };

  const seen = new Set();
  const out = [];

  for (const j of nodes.values()) {
    if (j.nbrs.size < 3 || distToRoute(j.x, j.y) > MAX_JUNCTION_SNAP_METERS) continue;

    // Where the route passes this junction (possibly more than once).
    const hits = [];
    for (const i of segIndex.near(j.x, j.y)) {
      const { dist, t } = segmentDistance(j.x, j.y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (dist <= MAX_JUNCTION_SNAP_METERS) hits.push({ s: cum[i] + t * (cum[i + 1] - cum[i]), dist });
    }
    hits.sort((a, b) => a.s - b.s);
    const passes = [];
    let cluster = [];
    const flush = () => {
      if (cluster.length) passes.push(cluster.reduce((a, b) => (b.dist < a.dist ? b : a)).s);
      cluster = [];
    };
    for (const h of hits) {
      if (cluster.length && h.s - cluster[cluster.length - 1].s > 40) flush();
      cluster.push(h);
    }
    flush();

    // The roads the route itself uses here: the arm it arrives on and the arm
    // it leaves on, matched by compass bearing. Everything else is a side road.
    const edges = edgesAt(j, nodes);
    const nearestEdge = (target) =>
      edges.reduce((a, b) => (Math.abs(angleDiff(b.bearing, target)) < Math.abs(angleDiff(a.bearing, target)) ? b : a));
    const routeArms = new Set();
    for (const s of passes) {
      const p = pointAt(s);
      if (s >= LOOKAROUND_METERS) {
        const before = pointAt(s - LOOKAROUND_METERS);
        routeArms.add(nearestEdge((bearing(p[0] - before[0], p[1] - before[1]) + 180) % 360).nbrId);
      }
      if (s <= total - LOOKAROUND_METERS) {
        const after = pointAt(s + LOOKAROUND_METERS);
        routeArms.add(nearestEdge(bearing(after[0] - p[0], after[1] - p[1])).nbrId);
      }
    }

    for (const [firstId, firstWay] of j.nbrs) {
      if (routeArms.has(firstId) || firstWay.tags.junction === 'roundabout' || seen.has(`${j.id}>${firstId}`)) continue;

      // Walk out along the road through plain mid-road nodes, stopping at the
      // length limit, the next junction, or a dead end.
      const stub = [j];
      let length = 0;
      let prev = j;
      let cur = nodes.get(firstId);
      const visited = new Set([j.id]);
      while (cur) {
        const step = Math.hypot(cur.x - prev.x, cur.y - prev.y);
        if (length + step > lengthMeters) {
          const t = (lengthMeters - length) / step;
          stub.push({ lat: prev.lat + t * (cur.lat - prev.lat), lon: prev.lon + t * (cur.lon - prev.lon), x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
          length = lengthMeters;
          break;
        }
        length += step;
        stub.push(cur);
        if (cur.nbrs.size !== 2 || visited.has(cur.id)) break;
        visited.add(cur.id);
        const nextId = [...cur.nbrs.keys()].find((id) => id !== prev.id);
        prev = cur;
        cur = nodes.get(nextId);
      }
      if (stub.length < 2) continue;

      // Mark this edge (and the same stub seen from its far end) as handled.
      seen.add(`${j.id}>${firstId}`);
      const last = stub[stub.length - 1];
      const beforeLast = stub[stub.length - 2];
      if (last.id != null && beforeLast.id != null) seen.add(`${last.id}>${beforeLast.id}`);

      // Skip the route's own road: every point past the first few meters hugs the track.
      let walked = 0;
      let onRoute = true;
      let checked = false;
      for (let k = 1; k < stub.length; k++) {
        walked += Math.hypot(stub[k].x - stub[k - 1].x, stub[k].y - stub[k - 1].y);
        if (walked >= MIN_ON_ROUTE_CHECK_METERS || k === stub.length - 1) {
          checked = true;
          if (distToRoute(stub[k].x, stub[k].y) > ON_ROUTE_METERS) {
            onRoute = false;
            break;
          }
        }
      }
      if (!checked || onRoute) continue;

      out.push(stub.map((n) => [Math.round(n.lat * 1e5) / 1e5, Math.round(n.lon * 1e5) / 1e5]));
    }
  }
  return out;
}

// ---------- convenience stores ----------

const STORE_SHOPS = new Set(['convenience', 'supermarket', 'grocery', 'general']);

/**
 * @param {object[]} elements Overpass nodes/ways/relations with `center` + `tags`
 * @returns {{lat, lon, name, desc, category}[]} stores within maxOffRouteMeters
 *          of the route, as POIs (category 'resupply' or 'fuel')
 */
export function deriveStores(track, elements, { maxOffRouteMeters = 500 } = {}) {
  const proj = makeProjector(track);
  const pts = track.map(([lat, lon]) => proj.toXY(lat, lon));
  const segIndex = buildSegmentIndex(pts, 600);
  const found = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    let category;
    let fallbackName;
    if (STORE_SHOPS.has(tags.shop)) {
      category = 'resupply';
      fallbackName = tags.shop === 'supermarket' ? 'Supermarket' : 'Convenience store';
    } else if (tags.amenity === 'fuel') {
      category = 'fuel';
      fallbackName = 'Gas station';
    } else {
      continue;
    }

    const [x, y] = proj.toXY(lat, lon);
    let off = Infinity;
    for (const i of segIndex.near(x, y)) {
      off = Math.min(off, segmentDistance(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]).dist);
    }
    // segIndex.near only looks at neighboring cells; fall back to a full scan
    // for stores in sparse areas so a valid store isn't dropped.
    if (!isFinite(off)) {
      for (let i = 0; i < pts.length - 1; i++) {
        off = Math.min(off, segmentDistance(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]).dist);
      }
    }
    if (off > maxOffRouteMeters) continue;

    const name = tags.name || tags.brand || tags.operator || fallbackName;
    const parts = [off < 60 ? 'On route' : `${(off / 1609.344).toFixed(1)} mi off route`];
    if (tags.opening_hours) parts.push(`Hours: ${tags.opening_hours}`);
    found.push({ lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, name, desc: parts.join(' · '), category, off });
  }

  // A store is often mapped as both a building outline and a node: drop
  // same-name entries within 60m of each other, keeping the closest to the route.
  found.sort((a, b) => a.off - b.off);
  const result = [];
  for (const f of found) {
    const dupe = result.some(
      (r) => r.name === f.name && Math.hypot((r.lat - f.lat) * METERS_PER_DEG, (r.lon - f.lon) * METERS_PER_DEG * Math.cos(f.lat * RAD)) < 60
    );
    if (!dupe) result.push(f);
  }
  return result.map(({ off, ...poi }) => poi);
}
