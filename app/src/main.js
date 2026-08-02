// Wires the UI: tabs, fog import + appearance, "% defogged" readout, route planning.
(function () {
  const $ = (id) => document.getElementById(id);

  const map = L.map("map", { center: [50, 15], zoom: 4, worldCopyJump: false });
  map.createPane("fog");
  map.getPane("fog").style.zIndex = 350;

  const BASEMAPS = {
    standard: { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", max: 19, attribution: "&copy; OpenStreetMap" },
    cycle:    { url: "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png", max: 20, sub: "abc", attribution: "&copy; CyclOSM &copy; OpenStreetMap" },
    voyager:  { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", max: 20, sub: "abcd", attribution: "&copy; OpenStreetMap &copy; CARTO" }
  };
  let baseLayer = null;
  function setBasemap(key) {
    const b = BASEMAPS[key] || BASEMAPS.standard;
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(b.url, { maxZoom: 19, maxNativeZoom: b.max, minZoom: 0, subdomains: b.sub || "abc", attribution: b.attribution });
    baseLayer.addTo(map);
    baseLayer.bringToBack();
  }
  setBasemap("standard");

  // ---- tabs -------------------------------------------------------------------
  const sidebar = document.getElementById("sidebar");
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === b.dataset.pane));
    sidebar.classList.add("open"); // mobile bottom sheet: tapping a tab unfurls the panel (no-op on desktop)
  }));
  // grab-handle toggles the bottom sheet open/collapsed on mobile
  document.getElementById("grabber").addEventListener("click", () => sidebar.classList.toggle("open"));

  // ---- fog layer + appearance -------------------------------------------------
  const fogMap = new FogParser.FogMap();
  let fogLayer = null;
  const SWATCHES = ["#2d3a4a", "#40639c", "#68509f", "#6a6f8a"]; // slate · blue · purple · blue-grey
  const WIDEN_MAX = 4;

  const saved = JSON.parse(localStorage.getItem("f2m_style") || "null");
  let style = saved || { target: "explored", color: "#2d3a4a", alpha: 150, dilate: 1 };
  if (style.dilate == null) style.dilate = 1;
  style.style = "tint";

  const persist = () => localStorage.setItem("f2m_style", JSON.stringify(style));
  function ensureLayer() {
    if (!fogLayer) {
      fogLayer = createFogLayer(fogMap, { pane: "fog", maxZoom: 19, minZoom: 0, updateWhenIdle: true, style: Object.assign({}, style) });
      fogLayer.addTo(map);
    } else fogLayer.setStyle(style);
  }

  const alpha = $("alpha"), colorPick = $("colorPick"), swatchBox = $("swatches");
  const widenVal = $("widenVal"), widenMinus = $("widenMinus"), widenPlus = $("widenPlus");
  const shadeSeg = $("shadeSeg");

  function syncControls() {
    shadeSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.target === style.target));
    alpha.value = style.alpha;
    colorPick.value = style.color;
    widenVal.textContent = style.dilate;
    widenMinus.disabled = style.dilate <= 0;
    widenPlus.disabled = style.dilate >= WIDEN_MAX;
    swatchBox.querySelectorAll(".sw:not(.add)").forEach((s) => s.classList.toggle("active", s.dataset.c === style.color));
  }
  function applyStyle(patch) {
    Object.assign(style, patch); persist(); syncControls();
    if (fogLayer) fogLayer.setStyle(style);
  }
  SWATCHES.forEach((c) => {
    const s = document.createElement("span");
    s.className = "sw"; s.style.background = c; s.dataset.c = c;
    s.addEventListener("click", () => applyStyle({ color: c }));
    swatchBox.appendChild(s);
  });
  const addSw = document.createElement("span");
  addSw.className = "sw add"; addSw.textContent = "+"; addSw.title = "Custom colour";
  addSw.addEventListener("click", () => colorPick.click());
  swatchBox.appendChild(addSw);

  shadeSeg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => applyStyle({ target: b.dataset.target })));
  alpha.addEventListener("input", () => applyStyle({ alpha: parseInt(alpha.value, 10) }));
  colorPick.addEventListener("input", () => applyStyle({ color: colorPick.value }));
  const stepWiden = (d) => applyStyle({ dilate: Math.max(0, Math.min(WIDEN_MAX, style.dilate + d)) });
  widenMinus.addEventListener("click", () => stepWiden(-1));
  widenPlus.addEventListener("click", () => stepWiden(1));
  syncControls();

  // ---- "% defogged" of the current view ---------------------------------------
  const hintEl = $("hint"), defogEl = $("defog"), defogPct = $("defogPct");
  // Always show two significant figures, however small the value — so a whole-world view
  // reads e.g. "0.00000056%" instead of collapsing to "0%". (0 stays "0%", 100 stays "100%".)
  function fmtPct(p) {
    if (!(p > 0)) return "0%";
    if (p >= 100) return "100%";
    const decimals = Math.max(0, 1 - Math.floor(Math.log10(p)));
    return p.toFixed(decimals) + "%";
  }
  function updateDefog() {
    if (!fogMap.tileCount) { hintEl.style.display = ""; defogEl.style.display = "none"; return; }
    hintEl.style.display = "none"; defogEl.style.display = "flex";
    // Exact count of defogged cells in the visible Mercator rectangle / total cells in it.
    // (Counting real cells — not a sampled grid — so tiny world-view fractions stay accurate.)
    const b = map.getBounds(), WC = FogParser.WORLD_CELLS;
    const nw = FogParser.lngLatToCell(b.getWest(), b.getNorth());
    const se = FogParser.lngLatToCell(b.getEast(), b.getSouth());
    const cx0 = Math.max(0, nw.cx), cy0 = Math.max(0, nw.cy);
    const cx1 = Math.min(WC, se.cx), cy1 = Math.min(WC, se.cy);
    const total = Math.max(0, cx1 - cx0) * Math.max(0, cy1 - cy0);
    const visited = total > 0 ? fogMap.countVisitedInCellRect(cx0, cy0, cx1, cy1) : 0;
    defogPct.textContent = fmtPct(total > 0 ? 100 * visited / total : 0);
  }
  map.on("moveend", updateDefog);
  $("basemap").addEventListener("change", (e) => setBasemap(e.target.value));

  // ---- data loading -----------------------------------------------------------
  const loadStatus = $("loadStatus");
  const setLoad = (m) => { loadStatus.textContent = m; };
  const inflateToTile = (name, buf) => fogMap.addTile(name, pako.inflate(new Uint8Array(buf)));
  function finishLoad() {
    ensureLayer();
    const b = fogMap.latLngBounds();
    if (b) map.fitBounds(b, { padding: [20, 20] });
    setLoad(`${fogMap.tileCount} tiles loaded ✓`);
    updateDefog();
    syncSug(); // fog just arrived — the Suggest button can wake up
  }
  async function loadFromInput(fileList) {
    const files = Array.from(fileList); if (!files.length) return;
    let ok = 0, readErr = 0, i = 0;
    for (const f of files) {
      let buf;
      try { buf = await f.arrayBuffer(); }
      catch (e) { readErr++; continue; } // e.g. a cloud placeholder that isn't downloaded to the device
      try { if (inflateToTile(f.name, buf)) ok++; } catch (e) {}
      if (++i % 50 === 0) setLoad(`Decoding… ${i}/${files.length}`);
    }
    if (ok > 0) {
      finishLoad();
      if (readErr > 0) setLoad(`${fogMap.tileCount} tiles loaded ✓ — ${readErr} file${readErr > 1 ? "s" : ""} couldn't be read (files kept only in the cloud aren't downloaded — try the .zip instead).`);
    } else if (readErr > 0) {
      setLoad("Couldn't read the files — if this folder lives in Google Drive or iCloud, it may not be downloaded to the phone. Download your backup and load the .zip instead.");
    } else {
      setLoad("No fog tiles found — did you pick the Sync folder?");
    }
  }
  $("folder").addEventListener("change", (e) => loadFromInput(e.target.files));

  async function loadFromZip(file) {
    if (!file) return;
    setLoad("Reading .zip…");
    let entries;
    try { entries = FogZip.unzip(await file.arrayBuffer()); }
    catch (e) { setLoad("Couldn't open that .zip — is it a Fog of World backup?"); return; }
    let ok = 0, i = 0;
    for (const ent of entries) {
      const base = ent.name.split(/[\\/]/).pop(); // tile filenames live under Sync/ inside the zip (tolerate \ or /)
      try { if (fogMap.addTile(base, pako.inflate(ent.data))) ok++; } catch (e) {}
      if (++i % 200 === 0) setLoad(`Decoding… ${i}/${entries.length}`);
    }
    if (ok > 0) finishLoad();
    else setLoad("No fog tiles found in that .zip — make sure it contains your Sync folder.");
  }
  $("zip").addEventListener("change", (e) => loadFromZip(e.target.files[0]));

  // ---- route planning ---------------------------------------------------------
  const exportGpxBtn = $("exportGpx"), exportKmlBtn = $("exportKml"), gmapsBtn = $("openGmaps");
  const drawBtn = $("drawToggle"), statsWrap = $("statsWrap"), routeHint = $("routeHint");
  const elevEl = $("elev"), elevHead = $("elevHead"), wpListEl = $("wpList"), wpHead = $("wpHead");
  const ELEV_MODES = new Set(["trekking", "fastbike", "hiking-mountain"]);
  const MODE_LABEL = { trekking: "bike route", fastbike: "road bike route", "hiking-mountain": "walk", "car-fast": "car route", rail: "rail route", shortest: "direct line" };
  const IDLE = "Tap the map to drop waypoints. Drag the line to bend it, drag a pin to move it, tap a pin to remove it.";
  let profile = "trekking";
  const DEFOG_HALF_M = 15; // assumed half-width of the corridor Fog of World clears as you travel
  let units = localStorage.getItem("f2m_units") || "metric";
  let lastStats = null, lastGain = null;

  const fmtDist = (km) => units === "imperial" ? (km * 0.621371).toFixed(1) + " mi" : km.toFixed(1) + " km";
  const fmtEle = (m) => units === "imperial" ? Math.round(m * 3.28084) + " ft" : Math.round(m) + " m";
  function fmtArea(m2) {
    if (units === "imperial") { const mi2 = m2 / 2589988; return mi2 >= 0.01 ? mi2.toFixed(2) + " mi²" : Math.round(m2 * 10.7639) + " ft²"; }
    const km2 = m2 / 1e6; return km2 >= 0.01 ? km2.toFixed(2) + " km²" : Math.round(m2) + " m²";
  }

  function setExports(routable) {
    exportGpxBtn.disabled = !routable; exportKmlBtn.disabled = !routable;
    gmapsBtn.disabled = route.wps.length < 2;
  }
  function clearRouteInfo(msg) {
    lastStats = null; lastGain = null;
    statsWrap.innerHTML = ""; routeHint.textContent = msg; routeHint.style.display = "";
    elevEl.innerHTML = ""; elevHead.style.display = "none";
  }

  const cellMetersAt = (lat) => (40075016.686 / FogParser.WORLD_CELLS) * Math.cos(lat * Math.PI / 180);

  // Is this point on genuinely new ground? True only if NO already-visited cell sits within
  // the ~DEFOG_HALF_M corridor — so weaving a cell off a road you've done doesn't read as new.
  function cellIsNew(lon, lat) {
    const r = Math.max(1, Math.round(DEFOG_HALF_M / cellMetersAt(lat)));
    const c = FogParser.lngLatToCell(lon, lat);
    const cx0 = Math.floor(c.cx), cy0 = Math.floor(c.cy);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
      if (fogMap.isVisitedCell(cx0 + dx, cy0 + dy)) return false;
    return true;
  }

  // What this route would defog: new area (cells in the clear-corridor) + the share of the
  // route's LENGTH that runs through never-visited ground.
  function computeGain(coords) {
    if (!fogMap.tileCount || coords.length < 2) return null;
    const cellM = cellMetersAt(coords[Math.floor(coords.length / 2)][1]);
    const r = Math.max(1, Math.round(DEFOG_HALF_M / cellM));
    const seen = new Set(); let newCells = 0;
    for (const p of coords) {
      const c = FogParser.lngLatToCell(p[0], p[1]);
      const cx0 = Math.floor(c.cx), cy0 = Math.floor(c.cy);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const cx = cx0 + dx, cy = cy0 + dy, key = cy * FogParser.WORLD_CELLS + cx;
        if (seen.has(key)) continue; seen.add(key);
        if (!fogMap.isVisitedCell(cx, cy)) newCells++;
      }
    }
    let total = 0, newLen = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = L.latLng(coords[i - 1][1], coords[i - 1][0]), b = L.latLng(coords[i][1], coords[i][0]);
      const d = a.distanceTo(b); total += d;
      if (cellIsNew((coords[i - 1][0] + coords[i][0]) / 2, (coords[i - 1][1] + coords[i][1]) / 2)) newLen += d;
    }
    return { area: newCells * cellM * cellM, newPct: total > 0 ? 100 * newLen / total : 0 };
  }

  function renderStats() {
    if (!lastStats) return;
    const s = lastStats;
    const gain = lastGain && lastGain.area > 0
      ? `<div class="statline gain"><span>defogs ~${fmtArea(lastGain.area)}</span><span>${fmtPct(lastGain.newPct)} new ground</span></div>` : "";
    statsWrap.innerHTML =
      `<div class="card"><span class="statbig">${fmtDist(s.km)}</span> <span class="statsub">${MODE_LABEL[profile] || ""}</span>` +
      `<div class="statline"><span>↑ ${fmtEle(s.ascent)}</span><span>↓ ${fmtEle(s.descent)}</span></div>${gain}</div>`;
  }

  function renderWps(list) {
    wpHead.style.display = list.length ? "" : "none";
    wpListEl.innerHTML = "";
    list.forEach((ll, i) => {
      const row = document.createElement("div");
      row.className = "wpRow";
      row.innerHTML =
        `<span class="n">${i + 1}</span>` +
        `<span class="co">${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}</span>` +
        `<button class="x" title="Remove">✕</button>`;
      row.querySelector(".co").addEventListener("click", () => map.panTo(ll));
      row.querySelector(".x").addEventListener("click", () => route.removeAt(i));
      wpListEl.appendChild(row);
    });
  }

  function renderElev() {
    const c = route.routeCoords;
    if (!ELEV_MODES.has(profile) || c.length < 2 || c[0].length < 3) { elevEl.innerHTML = ""; elevHead.style.display = "none"; return; }
    const W = 292, H = 78, padT = 8, padB = 15, padX = 4;
    const dists = [0]; let total = 0;
    for (let i = 1; i < c.length; i++) { total += L.latLng(c[i - 1][1], c[i - 1][0]).distanceTo(L.latLng(c[i][1], c[i][0])); dists.push(total); }
    if (total < 1) { elevEl.innerHTML = ""; elevHead.style.display = "none"; return; }
    const eles = c.map((p) => p[2]);
    let iMin = 0, iMax = 0;
    for (let i = 1; i < eles.length; i++) { if (eles[i] < eles[iMin]) iMin = i; if (eles[i] > eles[iMax]) iMax = i; }
    let emin = eles[iMin], emax = eles[iMax], span = emax - emin < 1 ? 1 : emax - emin;
    const x = (d) => padX + (d / total) * (W - 2 * padX);
    const y = (e) => padT + (1 - (e - emin) / span) * (H - padT - padB);
    let path = "M" + x(0) + "," + y(eles[0]);
    for (let i = 1; i < c.length; i++) path += " L" + x(dists[i]) + "," + y(eles[i]);
    const area = path + ` L${x(total)},${H - padB} L${x(0)},${H - padB} Z`;
    // labels placed at the actual high/low points (SVG isn't stretched, so use px coords)
    const clamp = (v) => Math.max(4, Math.min(W - 4, v));
    const anchor = (px) => px < 34 ? "start" : px > W - 34 ? "end" : "middle";
    const mx = x(dists[iMax]), my = y(emax), nx = x(dists[iMin]), ny = y(emin);
    const label = (val, px, py, dot) =>
      `<circle cx="${px}" cy="${dot}" r="2" fill="#3b4ad9"/>` +
      `<text class="lbl" x="${clamp(px)}" y="${py}" text-anchor="${anchor(px)}">${fmtEle(val)}</text>`;
    elevHead.style.display = "";
    elevEl.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}">` +
      `<path d="${area}" fill="#3b4ad922"/>` +
      `<path d="${path}" fill="none" stroke="#3b4ad9" stroke-width="1.6"/>` +
      label(emax, mx, my - 5 < 9 ? my + 12 : my - 5, my) +
      label(emin, nx, ny + 12 > H - 2 ? ny - 6 : ny + 12, ny) +
      `</svg>`;
  }

  const route = new RouteTool(map, {
    profile,
    isNew: cellIsNew,                       // colour the path: new ground vs already defogged
    fogReady: () => fogMap.tileCount > 0,
    onWaypoints: renderWps,
    onChange: (s) => {
      if (!s) { clearRouteInfo(IDLE); setExports(false); return; }
      if (s.loading) { routeHint.textContent = `Routing ${s.points} waypoints…`; routeHint.style.display = ""; return; }
      if (s.error) { clearRouteInfo("Routing server unreachable — showing a straight line."); setExports(route.routeCoords.length >= 2); return; }
      if (s.km == null) { clearRouteInfo(`${s.points} waypoint${s.points > 1 ? "s" : ""} — add one more to route.`); setExports(false); return; }
      lastStats = s; lastGain = computeGain(route.routeCoords);
      renderStats();
      routeHint.style.display = "none";
      setExports(true); renderElev();
    }
  });

  // ---- suggested routes ("Suggest" flow in the Plan tab) ----------------------
  const planSeg = $("planSeg"), drawPanel = $("drawPanel"), sugPanel = $("sugPanel");
  const sugStatus = $("sugStatus"), sugGo = $("sugGo"), sugReset = $("sugReset");
  const sugFogHint = $("sugFogHint"), sugResults = $("sugResults");
  const sugModeSeg = $("sugModeSeg"), sugBufSeg = $("sugBufSeg");
  const sugDistRow = $("sugDistRow"), sugDist = $("sugDist"), sugDistUnit = $("sugDistUnit");
  let lastSug = null;
  let sugBuffer = parseInt(localStorage.getItem("f2m_sugbuf") || "15", 10);
  let loopKm = parseFloat(localStorage.getItem("f2m_loopkm") || "10");

  const suggest = new SuggestTool(map, {
    fogMap,
    computeGain,
    isNew: cellIsNew, // previews get the same solid-new / hatched-old split as drawn routes
    onPoints: (n) => {
      sugStatus.textContent = suggest.mode === "loop"
        ? (n === 0 ? "Tap the map to set your loop's start." :
           "Start set — drag the pin to adjust, tap it to remove it.")
        : (n === 0 ? "Tap the map to set your start." :
           n === 1 ? "Now tap your destination." :
           "Start & end set — drag the pins to adjust, tap one to remove it.");
      if (n >= suggest.pointsNeeded()) sidebar.classList.add("open"); // mobile: bring the panel back up
      syncSug();
    },
    onResults: (s) => { lastSug = s; renderSug(); }
  });

  function syncSug() {
    const fogLoaded = fogMap.tileCount > 0;
    sugGo.disabled = suggest.pointCount() < suggest.pointsNeeded() || !fogLoaded;
    sugFogHint.style.display = fogLoaded ? "none" : "";
  }

  // loop distance is stored in km; the input shows it in the active unit
  function syncDistInput() {
    sugDistUnit.textContent = units === "imperial" ? "mi" : "km";
    sugDist.value = (units === "imperial" ? loopKm * 0.621371 : loopKm).toFixed(1).replace(/\.0$/, "");
  }
  syncDistInput();

  function renderSug() {
    const s = lastSug;
    if (!s) { sugResults.innerHTML = ""; return; }
    if (s.loading) {
      sugResults.innerHTML = `<div class="muted" style="margin-top:10px">${
        s.phase === "baseline" ? "Finding the fastest route…" :
        s.phase === "loops" ? `Routing loops… ${s.done}/${s.total}` :
        `Exploring detours… ${s.done}/${s.total}`}</div>`;
      return;
    }
    if (s.error) {
      sugResults.innerHTML = `<div class="muted" style="margin-top:10px">Routing server unreachable — try again in a moment.</div>`;
      return;
    }
    if (s.empty) {
      sugResults.innerHTML = `<div class="muted" style="margin-top:10px">${
        s.reason === "defogged"
          ? "Nothing left to defog around here — every candidate route runs through ground you've already covered. Try a different area" + (s.targetKm != null ? " or a longer distance." : " or a bigger buffer.")
          : s.reason === "server"
          ? "The routing server didn't return any routes — it may be busy right now, or this start may be hard to route from. Try again in a minute, or move the start pin."
          : `No loops landed within ±${s.bufferPct}% of ${fmtDist(s.targetKm)} — try a bigger buffer or a different distance.`}</div>`;
      return;
    }
    const isLoop = s.targetKm != null;
    const header = isLoop
      ? `Loops near ${fmtDist(s.targetKm)} (±${s.bufferPct}%), ranked by defogging — tap to preview:`
      : `Best defogging within ${fmtDist(s.baseKm * (1 + s.bufferPct / 100))} (fastest + ${s.bufferPct}%) — tap to preview:`;
    const deltaLabel = (c) => {
      if (!isLoop) return c.isBase ? "the fastest route" : "+" + fmtDist(c.deltaKm) + " extra";
      return (c.deltaKm >= 0 ? "+" : "−") + fmtDist(Math.abs(c.deltaKm)) + " vs target";
    };
    sugResults.innerHTML =
      `<div class="muted" style="margin:10px 0 2px">${header}</div>` +
      s.list.map((c, i) =>
        `<div class="sugCard${i === suggest.selected ? " sel" : ""}" data-i="${i}">
          <div class="sugTop"><span class="chip" style="background:${c.color}"></span><b>${fmtDist(c.km)}</b>
            <span class="muted">${deltaLabel(c)}</span>
            <button class="use act" data-use="${i}">Use</button></div>
          <div class="sugGain"><span>defogs ~${fmtArea(c.area)}</span><span>${fmtPct(c.newPct)} new ground</span></div>
          <div class="sugSub"><span>↑ ${fmtEle(c.ascent)}</span><span>↓ ${fmtEle(c.descent)}</span></div>
        </div>`).join("");
    sugResults.querySelectorAll(".sugCard").forEach((el) => el.addEventListener("click", () => {
      suggest.select(parseInt(el.dataset.i, 10));
      sugResults.querySelectorAll(".sugCard").forEach((x) => x.classList.toggle("sel", x === el));
    }));
    sugResults.querySelectorAll("[data-use]").forEach((el) => el.addEventListener("click", (e) => {
      e.stopPropagation();
      const wps = suggest.adopt(parseInt(el.dataset.use, 10));
      if (!wps) return;
      route.setWaypoints(wps);
      setSeg("draw"); // hand over to the editor: tweak pins, see the two-colour path, export
    }));
  }

  function setSeg(which) {
    planSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.s === which));
    drawPanel.style.display = which === "draw" ? "" : "none";
    sugPanel.style.display = which === "suggest" ? "" : "none";
    if (which === "suggest") {
      if (route.active) { route.setActive(false); drawBtn.textContent = "Start drawing"; drawBtn.style.background = ""; }
      suggest.setActive(true);
      syncSug();
      if (suggest.pointCount() < suggest.pointsNeeded()) sidebar.classList.remove("open"); // mobile: reveal the map to tap points
    } else {
      suggest.setActive(false);
    }
  }
  planSeg.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); setSeg(b.dataset.s); }));

  sugModeSeg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    sugModeSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    sugDistRow.style.display = b.dataset.m === "loop" ? "" : "none";
    suggest.setMode(b.dataset.m); // fires onPoints -> status text + button state
  }));

  sugBufSeg.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", parseInt(b.dataset.b, 10) === sugBuffer);
    b.addEventListener("click", () => {
      sugBuffer = parseInt(b.dataset.b, 10);
      localStorage.setItem("f2m_sugbuf", String(sugBuffer));
      sugBufSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      suggest.clearResults(); // old results were ranked under the old budget
    });
  });

  sugDist.addEventListener("change", () => {
    const v = parseFloat(sugDist.value);
    if (v > 0) loopKm = Math.min(300, units === "imperial" ? v / 0.621371 : v);
    localStorage.setItem("f2m_loopkm", String(loopKm));
    syncDistInput();
    suggest.clearResults();
  });

  sugGo.addEventListener("click", () => {
    route.clear(); // don't leave a hand-drawn route tangled under the previews
    suggest.suggest(profile, { buffer: sugBuffer / 100, distM: loopKm * 1000 });
  });
  sugReset.addEventListener("click", () => suggest.reset());

  const modeBtns = document.querySelectorAll("#modes button");
  function setMode(p) {
    profile = p;
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.p === p));
    route.setProfile(p);
    suggest.clearResults(); // suggestions were ranked for the old mode
  }
  modeBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.p)));
  setMode("trekking");

  // units toggle (km / mi)
  const unitSeg = $("unitSeg");
  unitSeg.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.u === units);
    b.addEventListener("click", () => {
      units = b.dataset.u; localStorage.setItem("f2m_units", units);
      unitSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      renderStats(); renderElev(); renderSug(); syncDistInput();
    });
  });

  drawBtn.addEventListener("click", () => {
    const on = !route.active;
    route.setActive(on);
    drawBtn.textContent = on ? "Stop drawing" : "Start drawing";
    drawBtn.style.background = on ? "#c9384f" : "";
    if (on) sidebar.classList.remove("open"); // mobile: drop the sheet so the map is tappable
  });
  $("undo").addEventListener("click", () => route.undo());
  $("clear").addEventListener("click", () => route.clear());
  exportGpxBtn.addEventListener("click", () => route.downloadGPX());
  exportKmlBtn.addEventListener("click", () => route.downloadKML());
  gmapsBtn.addEventListener("click", () => { const u = route.googleMapsUrl(); if (u) window.open(u, "_blank", "noopener"); });
})();
