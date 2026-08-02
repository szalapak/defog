// Route planning on the map, snapped to real roads/paths via BRouter (free, no key).
// - click to add a waypoint (endpoint)
// - drag a waypoint to move it; click a waypoint to remove it
// - drag the route LINE to insert a new waypoint mid-route and pull it through a point
// - exports the finished route as a GPX track (with elevation)
(function (global) {
  const BROUTER = "https://brouter.de/brouter";

  // Bigger, finger-friendly pins on touch screens (easier to grab, drag, and tap-to-remove).
  const COARSE = !!(global.matchMedia && global.matchMedia("(pointer: coarse)").matches);
  const WP_SZ = COARSE ? 26 : 18;
  function wpIcon(n) {
    return L.divIcon({ className: "", html: '<div class="wp">' + n + "</div>", iconSize: [WP_SZ, WP_SZ], iconAnchor: [WP_SZ / 2, WP_SZ / 2] });
  }

  function RouteTool(map, opts) {
    opts = opts || {};
    this.map = map;
    this.profile = opts.profile || "trekking";
    this.onChange = opts.onChange || null;       // stats
    this.onWaypoints = opts.onWaypoints || null; // waypoint list changed
    this.isNew = opts.isNew || null;         // (lon,lat) -> true if the point is new ground
    this.fogReady = opts.fogReady || null;   // () -> is fog data loaded?
    this.wps = [];            // { marker, latlng, _ri }
    this.routeCoords = [];    // [[lon,lat,ele], ...] from the last successful route
    // One-colour base line (waypoint-only / drag preview / no-fog fallback), plus two
    // fog-aware overlays: solid red where the route breaks new ground, dashed ("hatched")
    // red where you've already defogged.
    // Invisible, extra-thick "hit" line beneath the visible ones so the route is easy to
    // grab — especially with a fingertip. pointer-events:stroke makes it catch pointers
    // along its full width even though it's completely transparent.
    this.hit = L.polyline([], { weight: COARSE ? 30 : 16, opacity: 0, interactive: true }).addTo(map);
    const hitEl = this.hit.getElement && this.hit.getElement();
    if (hitEl) hitEl.setAttribute("pointer-events", "stroke");

    this.line = L.polyline([], { color: "#ff2d55", weight: 4, opacity: 0.95 }).addTo(map);
    this.segNew = L.polyline([], { color: "#ff2d55", weight: 5, opacity: 0.95 }).addTo(map);
    this.segOld = L.polyline([], { color: "#ff2d55", weight: 3.5, opacity: 0.85, dashArray: "2 8", lineCap: "round" }).addTo(map);
    this.active = false;
    this._reqId = 0;
    this._suppressClick = false;
    this._grabbing = false;

    this._onClick = (e) => {
      if (this._suppressClick) { this._suppressClick = false; return; }
      this.add(e.latlng);
    };

    // Grab the line to insert a waypoint mid-route. mousedown also fires from pointer/touch
    // on modern browsers; the explicit touchstart is a fallback for those without pointer events.
    [this.hit, this.line, this.segNew, this.segOld].forEach((l) => {
      l.on("mousedown", (e) => this._grabLine(e.latlng, e.originalEvent, false));
      const el = l.getElement && l.getElement();
      if (el) L.DomEvent.on(el, "touchstart", (ev) => {
        if (this._grabbing || this.wps.length < 2) return;
        if (ev.touches && ev.touches.length !== 1) return; // ignore pinch/multi-touch
        L.DomEvent.preventDefault(ev);
        this._grabLine(this._touchLatLng(ev.touches[0]), ev, true);
      });
    });
  }

  RouteTool.prototype._touchLatLng = function (t) {
    const r = this.map.getContainer().getBoundingClientRect();
    return this.map.containerPointToLatLng([t.clientX - r.left, t.clientY - r.top]);
  };

  RouteTool.prototype.setActive = function (on) {
    this.active = on;
    if (on) this.map.on("click", this._onClick);
    else this.map.off("click", this._onClick);
    this.map.getContainer().style.cursor = on ? "crosshair" : "";
  };

  RouteTool.prototype.setProfile = function (p) { this.profile = p; this._recalc(); };

  RouteTool.prototype._makeWp = function (latlng, index) {
    const marker = L.marker(latlng, { draggable: true, icon: wpIcon(index + 1) }).addTo(this.map);
    const wp = { marker, latlng, _ri: -1 };
    marker.on("dragend", () => { wp.latlng = marker.getLatLng(); this._recalc(); });
    marker.on("click", (e) => { L.DomEvent.stop(e); this._remove(wp); });
    return wp;
  };

  RouteTool.prototype.add = function (latlng) {
    this.wps.push(this._makeWp(latlng, this.wps.length));
    this._emitWps();
    this._recalc();
  };

  RouteTool.prototype._insertAt = function (i, latlng) {
    const wp = this._makeWp(latlng, i);
    this.wps.splice(i, 0, wp);
    this._relabel();
    return wp;
  };

  RouteTool.prototype._remove = function (wp) {
    const i = this.wps.indexOf(wp);
    if (i < 0) return;
    this.map.removeLayer(wp.marker);
    this.wps.splice(i, 1);
    this._relabel();
    this._emitWps();
    this._recalc();
  };
  RouteTool.prototype.removeAt = function (i) { if (this.wps[i]) this._remove(this.wps[i]); };
  RouteTool.prototype.undo = function () { if (this.wps.length) this._remove(this.wps[this.wps.length - 1]); };

  // Replace all waypoints at once (used when adopting a suggested route) — one recalc.
  RouteTool.prototype.setWaypoints = function (latlngs) {
    this.wps.forEach((w) => this.map.removeLayer(w.marker));
    this.wps = latlngs.map((ll, i) => this._makeWp(L.latLng(ll), i));
    this._emitWps();
    this._recalc();
  };

  RouteTool.prototype.clear = function () {
    this.wps.forEach((w) => this.map.removeLayer(w.marker));
    this.wps = [];
    this.routeCoords = [];
    this.line.setLatLngs([]);
    this.hit.setLatLngs([]);
    this._clearSegs();
    this._emitWps();
    this._emit(null);
  };

  RouteTool.prototype._clearSegs = function () { this.segNew.setLatLngs([]); this.segOld.setLatLngs([]); };

  // Draw the routed line. With fog loaded, split it into new-ground vs already-defogged runs
  // (two red styles); otherwise fall back to the single base line.
  RouteTool.prototype._renderLine = function (coords) {
    this.hit.setLatLngs(coords.map((c) => [c[1], c[0]])); // keep the grab target on the routed path
    if (!(this.isNew && this.fogReady && this.fogReady())) {
      this._clearSegs();
      this.line.setLatLngs(coords.map((c) => [c[1], c[0]]));
      return;
    }
    const newRuns = [], oldRuns = [];
    let cur = null, run = null;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const isNew = this.isNew((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (cur === null) { cur = isNew; run = [[a[1], a[0]]]; }
      else if (isNew !== cur) { (cur ? newRuns : oldRuns).push(run); cur = isNew; run = [[a[1], a[0]]]; }
      run.push([b[1], b[0]]);
    }
    if (run) (cur ? newRuns : oldRuns).push(run);
    this.line.setLatLngs([]);
    this.segNew.setLatLngs(newRuns);
    this.segOld.setLatLngs(oldRuns);
  };

  RouteTool.prototype._relabel = function () {
    this.wps.forEach((w, i) => w.marker.setIcon(wpIcon(i + 1)));
  };
  RouteTool.prototype._emit = function (s) { if (this.onChange) this.onChange(s); };
  RouteTool.prototype._emitWps = function () {
    if (this.onWaypoints) this.onWaypoints(this.wps.map((w) => w.latlng));
  };

  // ----- inserting a waypoint by grabbing the route line -----------------------
  RouteTool.prototype._nearestRouteIndex = function (latlng) {
    let best = 0, bd = Infinity;
    const c = this.routeCoords;
    for (let i = 0; i < c.length; i++) {
      const dx = c[i][0] - latlng.lng, dy = c[i][1] - latlng.lat;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  RouteTool.prototype._insertionIndex = function (latlng) {
    // which waypoint-gap does the grabbed point fall in? -> index to splice at
    if (this.routeCoords.length >= 2 && this.wps.every((w) => w._ri >= 0)) {
      const k = this._nearestRouteIndex(latlng);
      let a = 0;
      for (let i = 0; i < this.wps.length; i++) if (this.wps[i]._ri <= k) a = i;
      return Math.min(Math.max(a + 1, 1), this.wps.length);
    }
    // fallback: nearest straight segment between consecutive waypoints
    let best = 1, bd = Infinity;
    for (let i = 0; i < this.wps.length - 1; i++) {
      const d = L.LineUtil.pointToSegmentDistance(
        this.map.latLngToLayerPoint(latlng),
        this.map.latLngToLayerPoint(this.wps[i].latlng),
        this.map.latLngToLayerPoint(this.wps[i + 1].latlng));
      if (d < bd) { bd = d; best = i + 1; }
    }
    return best;
  };

  RouteTool.prototype._grabLine = function (latlng, oe, isTouch) {
    if (this._grabbing || this.wps.length < 2) return;
    this._grabbing = true;
    if (oe && !isTouch) L.DomEvent.stop(oe); // stop the mousedown so the map doesn't start panning
    this._suppressClick = true;
    const wp = this._insertAt(this._insertionIndex(latlng), latlng);
    this._emitWps();
    const map = this.map;
    this._clearSegs(); // show the single base line while dragging; segments redraw on release
    map.dragging.disable();
    const container = map.getContainer();

    const move = (ll) => { wp.latlng = ll; wp.marker.setLatLng(ll); this.line.setLatLngs(this.wps.map((w) => w.latlng)); };
    let cleanup;
    const finish = () => {
      cleanup();
      map.dragging.enable();
      this._grabbing = false;
      setTimeout(() => { this._suppressClick = false; }, 0);
      this._recalc();
    };

    if (isTouch) {
      const tmove = (ev) => { if (ev.touches && ev.touches[0]) { move(this._touchLatLng(ev.touches[0])); ev.preventDefault(); } };
      const tend = () => finish();
      cleanup = () => {
        container.removeEventListener("touchmove", tmove);
        container.removeEventListener("touchend", tend);
        container.removeEventListener("touchcancel", tend);
      };
      container.addEventListener("touchmove", tmove, { passive: false });
      container.addEventListener("touchend", tend);
      container.addEventListener("touchcancel", tend);
    } else {
      const mmove = (ev) => move(ev.latlng);
      const mup = () => finish();
      cleanup = () => { map.off("mousemove", mmove); map.off("mouseup", mup); };
      map.on("mousemove", mmove); map.on("mouseup", mup);
    }
  };

  // ----- routing ---------------------------------------------------------------
  RouteTool.prototype._recalc = async function () {
    if (this.wps.length < 2) {
      this.routeCoords = [];
      this._clearSegs();
      this.line.setLatLngs(this.wps.map((w) => w.latlng));
      this.hit.setLatLngs(this.wps.map((w) => w.latlng));
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
      if (reqId !== this._reqId) return; // superseded
      const feat = gj.features[0];
      const coords = feat.geometry.coordinates;
      this.routeCoords = coords;
      this._renderLine(coords);
      this._indexWaypoints();
      this._emit(Object.assign({ points: this.wps.length }, this._stats(feat, coords)));
    } catch (e) {
      if (reqId !== this._reqId) return;
      this.routeCoords = this.wps.map((w) => [w.latlng.lng, w.latlng.lat]);
      this._clearSegs();
      this.line.setLatLngs(this.wps.map((w) => w.latlng));
      this.hit.setLatLngs(this.wps.map((w) => w.latlng));
      this._emit({ points: this.wps.length, error: true });
    }
  };

  RouteTool.prototype._indexWaypoints = function () {
    for (const w of this.wps) w._ri = this._nearestRouteIndex(w.latlng);
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

  // ----- export ----------------------------------------------------------------
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

  RouteTool.prototype.toKML = function () {
    const name = "FogToMaps route (" + this.profile + ")";
    const coords = this.routeCoords
      .map((c) => c[0].toFixed(6) + "," + c[1].toFixed(6) + "," + (c.length > 2 ? c[2].toFixed(1) : "0"))
      .join(" ");
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>${name}</name>
  <Style id="r"><LineStyle><color>ff5522ff</color><width>4</width></LineStyle></Style>
  <Placemark><name>${name}</name><styleUrl>#r</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
  </Placemark>
</Document></kml>`;
  };

  function saveBlob(text, mime, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  RouteTool.prototype.downloadGPX = function () {
    if (this.routeCoords.length < 2) return false;
    saveBlob(this.toGPX(), "application/gpx+xml", "fogtomaps-route.gpx");
    return true;
  };
  RouteTool.prototype.downloadKML = function () {
    if (this.routeCoords.length < 2) return false;
    saveBlob(this.toKML(), "application/vnd.google-earth.kml+xml", "fogtomaps-route.kml");
    return true;
  };

  // Google Maps directions URL from the waypoints (Google re-routes via its own engine).
  // travelmode: driving | bicycling | walking | transit
  RouteTool.prototype.googleMapsUrl = function () {
    if (this.wps.length < 2) return null;
    const MODE = { "car-fast": "driving", rail: "transit", "hiking-mountain": "walking" };
    const mode = MODE[this.profile] || (this.profile === "shortest" ? "driving" : "bicycling");
    const pts = this.wps.map((w) => w.latlng.lat.toFixed(6) + "," + w.latlng.lng.toFixed(6));
    const origin = pts.shift(), destination = pts.pop();
    let url = "https://www.google.com/maps/dir/?api=1&travelmode=" + mode +
      "&origin=" + origin + "&destination=" + destination;
    if (pts.length) url += "&waypoints=" + pts.join("%7C"); // %7C = |
    return url;
  };

  global.RouteTool = RouteTool;
})(window);
