// Route planning on the map, snapped to real roads/paths via BRouter (free, no key).
// Click to add waypoints; drag to move; click a point to remove. Re-routes on every
// change. Exports the finished route as a GPX track (with elevation).
(function (global) {
  const BROUTER = "https://brouter.de/brouter";

  function wpIcon(n) {
    return L.divIcon({ className: "", html: '<div class="wp">' + n + "</div>", iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  function RouteTool(map, opts) {
    opts = opts || {};
    this.map = map;
    this.profile = opts.profile || "trekking";
    this.onChange = opts.onChange || null;
    this.wps = [];            // { marker, latlng }
    this.routeCoords = [];    // [[lon,lat,ele], ...] from the last successful route
    this.line = L.polyline([], { color: "#ff2d55", weight: 4, opacity: 0.95 }).addTo(map);
    this.active = false;
    this._reqId = 0;
    this._onClick = (e) => this.add(e.latlng);
  }

  RouteTool.prototype.setActive = function (on) {
    this.active = on;
    if (on) this.map.on("click", this._onClick);
    else this.map.off("click", this._onClick);
    this.map.getContainer().style.cursor = on ? "crosshair" : "";
  };

  RouteTool.prototype.setProfile = function (p) { this.profile = p; this._recalc(); };

  RouteTool.prototype.add = function (latlng) {
    const marker = L.marker(latlng, { draggable: true, icon: wpIcon(this.wps.length + 1) }).addTo(this.map);
    const wp = { marker, latlng };
    marker.on("dragend", () => { wp.latlng = marker.getLatLng(); this._recalc(); });
    marker.on("click", (e) => { L.DomEvent.stop(e); this._remove(wp); });
    this.wps.push(wp);
    this._recalc();
  };

  RouteTool.prototype._remove = function (wp) {
    const i = this.wps.indexOf(wp);
    if (i < 0) return;
    this.map.removeLayer(wp.marker);
    this.wps.splice(i, 1);
    this._relabel();
    this._recalc();
  };

  RouteTool.prototype.undo = function () {
    if (this.wps.length) this._remove(this.wps[this.wps.length - 1]);
  };

  RouteTool.prototype.clear = function () {
    this.wps.forEach((w) => this.map.removeLayer(w.marker));
    this.wps = [];
    this.routeCoords = [];
    this.line.setLatLngs([]);
    this._emit(null);
  };

  RouteTool.prototype._relabel = function () {
    this.wps.forEach((w, i) => w.marker.setIcon(wpIcon(i + 1)));
  };

  RouteTool.prototype._emit = function (stats) {
    if (this.onChange) this.onChange(stats);
  };

  RouteTool.prototype._recalc = async function () {
    if (this.wps.length < 2) {
      this.routeCoords = [];
      this.line.setLatLngs(this.wps.map((w) => w.latlng));
      this._emit(this.wps.length ? { points: this.wps.length } : null);
      return;
    }
    const reqId = ++this._reqId;
    this._emit({ points: this.wps.length, loading: true });
    const lonlats = this.wps.map((w) => w.latlng.lng.toFixed(6) + "," + w.latlng.lat.toFixed(6)).join("|");
    const url = `${BROUTER}?lonlats=${lonlats}&profile=${encodeURIComponent(this.profile)}&alternativeidx=0&format=geojson`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const gj = await res.json();
      if (reqId !== this._reqId) return; // a newer request superseded this one
      const feat = gj.features[0];
      const coords = feat.geometry.coordinates; // [lon,lat,ele]
      this.routeCoords = coords;
      this.line.setLatLngs(coords.map((c) => [c[1], c[0]]));
      this._emit(Object.assign({ points: this.wps.length }, this._stats(feat, coords)));
    } catch (e) {
      if (reqId !== this._reqId) return;
      // fallback: straight dashed line between waypoints so the user still sees intent
      this.routeCoords = this.wps.map((w) => [w.latlng.lng, w.latlng.lat]);
      this.line.setLatLngs(this.wps.map((w) => w.latlng));
      this._emit({ points: this.wps.length, error: true });
    }
  };

  RouteTool.prototype._stats = function (feat, coords) {
    const p = feat.properties || {};
    let asc = 0, desc = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = (coords[i][2] || 0) - (coords[i - 1][2] || 0);
      if (d > 0) asc += d; else desc -= d;
    }
    return {
      km: (parseInt(p["track-length"], 10) || 0) / 1000,
      seconds: parseInt(p["total-time"], 10) || 0,
      ascent: Math.round(asc),
      descent: Math.round(desc)
    };
  };

  RouteTool.prototype.toGPX = function () {
    const name = "FogToMaps route (" + this.profile + ")";
    const pts = this.routeCoords.map((c) => {
      const ele = c.length > 2 ? `<ele>${c[2].toFixed(1)}</ele>` : "";
      return `      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${ele}</trkpt>`;
    }).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FogToMaps" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
  };

  RouteTool.prototype.downloadGPX = function () {
    if (this.routeCoords.length < 2) return false;
    const blob = new Blob([this.toGPX()], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fogtomaps-route.gpx";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    return true;
  };

  global.RouteTool = RouteTool;
})(window);
