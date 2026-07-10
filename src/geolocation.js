import L from 'leaflet';

// Both the GPS fix and the compass are on-device hardware (no network calls),
// so this works fully offline — that's not something we had to build for,
// it's just how these browser APIs work.

const HEADING_SMOOTHING = 0.25; // low-pass filter so the heading arrow doesn't jitter

function describeGeoError(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'Location permission denied. Enable it in Settings → Privacy → Location Services → Safari (or Settings → [this app] if installed to your Home Screen).';
    case err.POSITION_UNAVAILABLE:
      return 'Location unavailable right now.';
    case err.TIMEOUT:
      return 'Timed out getting your location — try again in the open.';
    default:
      return 'Could not get your location.';
  }
}

// iOS Safari (13+) gates DeviceOrientationEvent behind an explicit,
// user-gesture-triggered permission prompt, and only exposes a true compass
// heading via the non-standard `webkitCompassHeading` field. Other browsers
// (desktop, most Android) need neither and expose heading via `alpha` on the
// standard event instead.
// Returns 'granted', 'denied' (user/OS said no to a real prompt — worth
// telling the user how to fix it), or 'unsupported' (no compass API on this
// device/browser at all — nothing actionable to tell them).
async function requestOrientationPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      return (await DOE.requestPermission()) === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }
  return 'DeviceOrientationEvent' in window ? 'granted' : 'unsupported';
}

function computeHeadingFromOrientation(event) {
  if (typeof event.webkitCompassHeading === 'number') {
    // iOS reports -1 when the compass needs calibration (e.g. right after
    // the permission prompt, before the first good reading) — not a real
    // heading, so don't rotate the arrow to a bogus "north".
    if (event.webkitCompassHeading < 0) return null;
    return event.webkitCompassHeading; // otherwise already true-north degrees
  }
  if (event.absolute && typeof event.alpha === 'number') {
    const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
    return (360 - event.alpha + screenAngle) % 360;
  }
  return null;
}

export function createLocationTracker(map, { onStatus, onPosition, onHeading } = {}) {
  let watchId = null;
  let orientationHandler = null;
  let following = false;
  let smoothedHeading = null;
  let markerAdded = false;
  let headingState = null; // null = not asked yet, else 'granted' | 'denied' | 'unsupported'

  const icon = L.divIcon({
    className: 'geo-marker',
    html: '<div class="geo-heading"></div><div class="geo-dot"></div>',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
  const marker = L.marker([0, 0], { icon, zIndexOffset: 1000, interactive: false });
  const accuracyCircle = L.circle([0, 0], {
    radius: 0,
    color: '#2b83ff',
    weight: 1,
    fillColor: '#2b83ff',
    fillOpacity: 0.12,
    interactive: false,
  });

  function report(extra) {
    onStatus?.({ tracking: watchId != null, following, headingState, ...extra });
  }

  function setHeading(heading) {
    if (heading == null) return;
    if (smoothedHeading == null) {
      smoothedHeading = heading;
    } else {
      const delta = ((heading - smoothedHeading + 540) % 360) - 180;
      smoothedHeading = (smoothedHeading + delta * HEADING_SMOOTHING + 360) % 360;
    }
    const el = marker.getElement()?.querySelector('.geo-heading');
    if (el) {
      // .geo-heading is `display: none` by default in CSS so the cone is
      // hidden until a real heading arrives. Clearing the inline style here
      // (`= ''`) would just fall back to that class rule, not reveal it —
      // has to be set to an actual displayed value.
      el.style.display = 'block';
      el.style.transform = `rotate(${smoothedHeading}deg)`;
    }
    onHeading?.(smoothedHeading);
  }

  function handleOrientation(event) {
    setHeading(computeHeadingFromOrientation(event));
  }

  function handlePosition(pos) {
    const { latitude, longitude, accuracy, heading } = pos.coords;
    const latlng = [latitude, longitude];
    marker.setLatLng(latlng);
    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(accuracy || 0);
    if (!markerAdded) {
      marker.addTo(map);
      accuracyCircle.addTo(map);
      markerAdded = true;
    }
    // GPS course-over-ground only exists while moving, and only matters as a
    // fallback when there's no live compass reading.
    if (heading != null && !orientationHandler) setHeading(heading);

    if (following) {
      map.setView(latlng, Math.max(map.getZoom(), 15), { animate: true });
    }
    report({ error: null });
    onPosition?.({ lat: latitude, lon: longitude, accuracy });
  }

  // 'dragstart' only fires for an actual user drag gesture (Leaflet's Drag
  // handler), unlike the more general 'movestart' which also fires for our
  // own programmatic setView() calls (including follow mode's) — so this
  // is a reliable "the user manually panned" signal with no flag-tracking
  // needed to distinguish it from our own moves.
  map.on('dragstart', () => {
    if (following) {
      following = false;
      report({});
    }
  });

  async function start() {
    if (!('geolocation' in navigator)) {
      report({ error: 'Geolocation is not available in this browser.' });
      return;
    }
    following = true;
    report({});

    headingState = await requestOrientationPermission();
    if (headingState === 'granted') {
      orientationHandler = handleOrientation;
      window.addEventListener('deviceorientation', orientationHandler);
    }
    report({});

    watchId = navigator.geolocation.watchPosition(
      handlePosition,
      (err) => report({ error: describeGeoError(err) }),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }

  function stop() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (orientationHandler) window.removeEventListener('deviceorientation', orientationHandler);
    orientationHandler = null;
    following = false;
    smoothedHeading = null;
    if (markerAdded) {
      map.removeLayer(marker);
      map.removeLayer(accuracyCircle);
      markerAdded = false;
    }
    report({ error: null });
  }

  function recenter() {
    following = true;
    if (markerAdded) {
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
    }
    report({});
  }

  return {
    start,
    stop,
    recenter,
    isActive: () => watchId != null,
    isFollowing: () => following,
    getLatLng: () => (markerAdded ? marker.getLatLng() : null),
    getHeading: () => smoothedHeading,
  };
}
