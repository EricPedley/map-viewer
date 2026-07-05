// Finds the nearest recorded track point to a lat/lon and returns how far
// along the route (in meters from the start) that point is — a simple stand-in
// for "what mileage am I at" that's accurate to the ~38m average spacing
// between recorded GPX points, which is plenty at route-mileage granularity.
const METERS_PER_DEGREE_LAT = 111320;

export function nearestRouteDistanceMeters(track, distances, lat, lon) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let bestIndex = 0;
  let bestDist2 = Infinity;
  for (let i = 0; i < track.length; i++) {
    const dLat = (track[i][0] - lat) * METERS_PER_DEGREE_LAT;
    const dLon = (track[i][1] - lon) * METERS_PER_DEGREE_LAT * cosLat;
    const dist2 = dLat * dLat + dLon * dLon;
    if (dist2 < bestDist2) {
      bestDist2 = dist2;
      bestIndex = i;
    }
  }
  return distances[bestIndex];
}

export function metersToMiles(meters) {
  return meters * 0.000621371192;
}
