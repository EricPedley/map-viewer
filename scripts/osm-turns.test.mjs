import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTurnCues, deriveStores, simplifyTrack, describeWay, makeProjector } from './osm-turns.mjs';

// Synthetic world: coordinates are meters east/north of a fixed origin.
const ORIGIN = [33.0, -117.0];
const toLL = (x, y) => [ORIGIN[0] + y / 111320, ORIGIN[1] + x / (111320 * Math.cos(ORIGIN[0] * Math.PI / 180))];
const gnode = (id, x, y) => { const [lat, lon] = toLL(x, y); return { id, lat, lon }; };

let nextWayId = 1;
// A way through the given [id, x, y] nodes.
function way(tags, ...pts) {
  return { id: nextWayId++, tags: { highway: 'residential', ...tags }, nodes: pts.map((p) => p[0]), geometry: pts.map(([id, x, y]) => ({ lat: toLL(x, y)[0], lon: toLL(x, y)[1] })) };
}

// Track along a polyline of [x, y] waypoints, a point every `step` meters.
function makeTrack(waypoints, step = 20) {
  const track = [];
  const distances = [];
  let total = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [ax, ay] = waypoints[i];
    const [bx, by] = waypoints[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const [lat, lon] = toLL(ax + t * (bx - ax), ay + t * (by - ay));
      track.push([lat, lon, 100]);
      distances.push(total + t * len);
    }
    total += len;
  }
  const [lat, lon] = toLL(...waypoints[waypoints.length - 1]);
  track.push([lat, lon, 100]);
  distances.push(total);
  return { track, distances };
}

// A 5x4 street grid, 100m blocks. Columns are "Oak St", rows are "Main St".
function gridWays() {
  const ways = [];
  const id = (i, j) => 1000 + i * 10 + j;
  for (let j = 0; j <= 3; j++) ways.push(way({ name: 'Main St' }, ...[0, 1, 2, 3, 4].map((i) => [id(i, j), i * 100, -j * 100])));
  for (let i = 0; i <= 4; i++) ways.push(way({ name: 'Oak St' }, ...[0, 1, 2, 3].map((j) => [id(i, j), i * 100, -j * 100])));
  return ways;
}

test('grid: straight through crossings gets no cue; right then left turn are found', () => {
  // East along y=0 to x=300, right (south) to y=-200, left (east) to x=400.
  const { track, distances } = makeTrack([[0, 0], [300, 0], [300, -200], [400, -200]]);
  const cues = deriveTurnCues(track, distances, gridWays());
  assert.deepEqual(cues.map((c) => c.direction), ['Right', 'Left']);
  assert.equal(cues[0].instruction, 'Turn right onto Oak St');
  assert.equal(cues[1].instruction, 'Turn left onto Main St');
  assert.ok(Math.abs(cues[0].dist - 300) < 5, `dist ${cues[0].dist}`);
  assert.ok(Math.abs(cues[1].dist - 500) < 5, `dist ${cues[1].dist}`);
});

test('grid: cue coordinates are the junction, and cues come back in route order', () => {
  const { track, distances } = makeTrack([[0, 0], [300, 0], [300, -200], [400, -200]]);
  const cues = deriveTurnCues(track, distances, gridWays());
  const [lat, lon] = toLL(300, 0);
  assert.ok(Math.abs(cues[0].lat - lat) < 1e-5 && Math.abs(cues[0].lon - lon) < 1e-5);
  assert.ok(cues[0].dist < cues[1].dist);
});

test('a bend with no other road branching off is not a decision', () => {
  // L-shaped road, nothing else. Must produce no cue at the corner.
  const ways = [way({ name: 'Lone Rd' }, [1, 0, 0], [2, 200, 0], [3, 200, -200])];
  const { track, distances } = makeTrack([[0, 0], [200, 0], [200, -200]]);
  assert.deepEqual(deriveTurnCues(track, distances, ways), []);
});

test('Y-fork: keeping to the right branch says keep right', () => {
  const ways = [
    way({ name: 'Stem Rd' }, [1, 0, 0], [2, 0, 200]),
    way({ name: 'Left Branch' }, [2, 0, 200], [3, -35, 400]),
    way({ name: 'Right Branch' }, [2, 0, 200], [4, 35, 400]),
  ];
  const { track, distances } = makeTrack([[0, 0], [0, 200], [35, 400]]);
  const cues = deriveTurnCues(track, distances, ways);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].direction, 'Slight Right');
  assert.equal(cues[0].instruction, 'Keep right onto Right Branch');
});

test('unnamed gravel road is described rather than named', () => {
  const ways = [
    way({ name: 'Paved Rd' }, [1, 0, 0], [2, 200, 0], [3, 400, 0]),
    way({ highway: 'track', surface: 'gravel' }, [2, 200, 0], [4, 200, -200]),
  ];
  const { track, distances } = makeTrack([[0, 0], [200, 0], [200, -200]]);
  const cues = deriveTurnCues(track, distances, ways);
  assert.equal(cues[0].instruction, 'Turn right onto dirt road');
});

test('footways are ignored as alternatives', () => {
  const ways = [
    way({ name: 'A St' }, [1, 0, 0], [2, 200, 0]),
    way({ name: 'B St' }, [2, 200, 0], [3, 200, -200]),
    way({ highway: 'footway' }, [2, 200, 0], [4, 200, 100]),
  ];
  const { track, distances } = makeTrack([[0, 0], [200, 0], [200, -200]]);
  assert.deepEqual(deriveTurnCues(track, distances, ways), []); // only a footway "branches" off
});

test('roundabout collapses to one "Nth exit" cue', () => {
  // Ring at the origin, radius 15m, four arms. Enter from the south, pass the
  // east arm (exit 1), leave by the north arm (exit 2).
  const r = 15;
  const ring = way({ junction: 'roundabout', name: 'Circle' }, [10, 0, -r], [11, r, 0], [12, 0, r], [13, -r, 0], [10, 0, -r]);
  const arms = [
    way({ name: 'South Rd' }, [20, 0, -200], [10, 0, -r]),
    way({ name: 'East Rd' }, [11, r, 0], [21, 200, 0]),
    way({ name: 'North Rd' }, [12, 0, r], [22, 0, 200]),
    way({ name: 'West Rd' }, [13, -r, 0], [23, -200, 0]),
  ];
  const k = r * Math.SQRT1_2;
  const { track, distances } = makeTrack([[0, -200], [0, -r], [k, -k], [r, 0], [k, k], [0, r], [0, 200]], 10);
  const cues = deriveTurnCues(track, distances, [ring, ...arms]);
  assert.equal(cues.length, 1, JSON.stringify(cues));
  assert.equal(cues[0].instruction, 'At the roundabout, take the 2nd exit onto North Rd');
  assert.equal(cues[0].direction, 'Straight');
});

test('simplifyTrack keeps endpoints and corners, drops collinear points', () => {
  const { track } = makeTrack([[0, 0], [500, 0], [500, 500]], 10);
  const simple = simplifyTrack(track, 5);
  assert.ok(simple.length <= 4 && simple.length >= 3, `got ${simple.length}`);
  assert.deepEqual(simple[0], track[0]);
  assert.deepEqual(simple[simple.length - 1], track[track.length - 1]);
});

test('describeWay', () => {
  assert.equal(describeWay({ name: 'Elm St', ref: 'CR-4' }), 'Elm St, CR-4');
  assert.equal(describeWay({ highway: 'cycleway' }), 'bike path');
  assert.equal(describeWay({ highway: 'residential' }), null);
});

test('stores: keeps nearby convenience stores + gas, drops far/other, dedupes', () => {
  const { track } = makeTrack([[0, 0], [2000, 0]], 25);
  const at = (x, y) => ({ lat: toLL(x, y)[0], lon: toLL(x, y)[1] });
  const elements = [
    { type: 'node', ...at(500, 200), tags: { shop: 'convenience', name: 'Circle K', opening_hours: '24/7' } },
    { type: 'way', center: at(502, 202), tags: { shop: 'convenience', name: 'Circle K' } }, // duplicate outline
    { type: 'node', ...at(1200, 300), tags: { shop: 'supermarket' } },
    { type: 'node', ...at(1500, 10), tags: { amenity: 'fuel', brand: 'Shell' } },
    { type: 'node', ...at(900, 2000), tags: { shop: 'convenience', name: 'Too Far' } },
    { type: 'node', ...at(300, 20), tags: { shop: 'clothes', name: 'Boutique' } },
  ];
  const stores = deriveStores(track, elements);
  assert.deepEqual(stores.map((s) => s.name).sort(), ['Circle K', 'Shell', 'Supermarket']);
  const circleK = stores.find((s) => s.name === 'Circle K');
  assert.equal(circleK.category, 'resupply');
  assert.match(circleK.desc, /mi off route/);
  assert.match(circleK.desc, /Hours: 24\/7/);
  assert.equal(stores.find((s) => s.name === 'Shell').category, 'fuel');
  assert.match(stores.find((s) => s.name === 'Shell').desc, /^On route/);
});
