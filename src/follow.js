import { destinationPoint } from './projection.js';

// "Driving view" nav mode: rotates the map so the rider's heading points up
// the screen and tilts it for a pseudo-3D look-ahead perspective, the way
// Google Maps' navigation view does. This is a pure CSS trick (rotate/tiltX
// on wrapper elements around the Leaflet container) rather than a rotation
// -aware Leaflet fork — Leaflet itself keeps thinking north is up and never
// finds out, which is fine because we disable the gesture-based interactions
// (drag/pinch) that would otherwise need to translate an on-screen tap
// through the rotated/tilted view back into a real map coordinate.
const NAV_ZOOM = 17;
const TILT_DEG = 55;
const LOOK_AHEAD_METERS = 70;

export function createFollowMode(map, { mapEl, tiltWrapEl }) {
  let active = false;

  function setInteractive(enabled) {
    const toggle = (handler) => (enabled ? handler.enable() : handler.disable());
    toggle(map.dragging);
    toggle(map.touchZoom);
    toggle(map.doubleClickZoom);
    toggle(map.scrollWheelZoom);
  }

  function enable(lat, lon, headingDeg) {
    if (active) return;
    active = true;
    document.body.classList.add('follow-mode');
    tiltWrapEl.style.transform = `rotateX(${TILT_DEG}deg)`;
    setInteractive(false);
    // The rotated/tilted view's on-screen rectangle no longer matches the
    // axis-aligned box Leaflet measures, so give it more room (and a wider
    // tile keepBuffer, set on the layer itself) to cover the corners.
    mapEl.classList.add('map-enlarged');
    map.invalidateSize({ animate: false });
    updateHeading(headingDeg ?? 0);
    if (lat != null && lon != null) {
      const [aheadLat, aheadLon] = destinationPoint(lat, lon, headingDeg ?? 0, LOOK_AHEAD_METERS);
      map.setView([aheadLat, aheadLon], NAV_ZOOM, { animate: false });
    }
  }

  function disable() {
    if (!active) return;
    active = false;
    document.body.classList.remove('follow-mode');
    tiltWrapEl.style.transform = '';
    mapEl.style.transform = '';
    mapEl.classList.remove('map-enlarged');
    setInteractive(true);
    map.invalidateSize({ animate: false });
  }

  function updateHeading(headingDeg) {
    if (!active) return;
    mapEl.style.transform = `rotate(${-headingDeg}deg)`;
  }

  function updatePosition(lat, lon, headingDeg) {
    if (!active) return;
    // Preserve whatever zoom the +/- buttons are currently set to (only the
    // initial `enable()` forces NAV_ZOOM) — dragging/pinch are disabled in
    // this mode, but the zoom buttons still work and shouldn't get fought.
    const [aheadLat, aheadLon] = destinationPoint(lat, lon, headingDeg ?? 0, LOOK_AHEAD_METERS);
    map.setView([aheadLat, aheadLon], map.getZoom(), { animate: true });
  }

  return { enable, disable, updateHeading, updatePosition, isActive: () => active };
}
