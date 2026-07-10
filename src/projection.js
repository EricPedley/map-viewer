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

// Standard spherical "destination point given distance and bearing" formula.
// Used to project a point ahead of the rider along their heading, so the
// follow-mode camera can look further down the road instead of centering
// directly on the rider (which is what "look-ahead" navigation views do).
const EARTH_RADIUS_METERS = 6371000;

export function destinationPoint(lat, lon, bearingDeg, distanceMeters) {
  const bearing = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const dByR = distanceMeters / EARTH_RADIUS_METERS;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dByR) + Math.cos(lat1) * Math.sin(dByR) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(dByR) * Math.cos(lat1),
      Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
    );

  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}
