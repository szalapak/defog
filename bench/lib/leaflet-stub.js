// Minimal Leaflet stand-in: just enough surface for suggest.js to run headless.
// Geometry helpers are real (haversine); everything visual is a no-op.
"use strict";

function LatLng(lat, lng) { this.lat = lat; this.lng = lng; }
LatLng.prototype.distanceTo = function (o) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (o.lat - this.lat) * rad, dLng = (o.lng - this.lng) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(this.lat * rad) * Math.cos(o.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

function Bounds(a, b) { this.pts = [a, b]; }
Bounds.prototype.extend = function (p) { this.pts.push(p); return this; };

const noopLayer = () => {
  const l = { addTo: () => l, setStyle: () => l, setLatLngs: () => l, on: () => l, getElement: () => null };
  return l;
};

global.L = {
  latLng: (lat, lng) => (lat instanceof LatLng ? lat : new LatLng(lat, lng)),
  latLngBounds: (a, b) => new Bounds(a, b),
  polyline: noopLayer,
  marker: noopLayer,
  divIcon: () => ({}),
  DomEvent: { stop: () => {}, on: () => {} }
};

global.fakeMap = () => ({
  on: () => {}, off: () => {}, addLayer: () => {}, removeLayer: () => {},
  fitBounds: () => {}, getContainer: () => ({ style: {} })
});
