// Wires the UI: tabs, fog import + appearance, "% defogged" readout, route planning.
(function () {
  const $ = (id) => document.getElementById(id);

  const map = L.map("map", { center: [50, 15], zoom: 4, worldCopyJump: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  map.createPane("fog");
  map.getPane("fog").style.zIndex = 350;

  // ---- tabs -------------------------------------------------------------------
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === b.dataset.pane));
  }));

  // ---- fog layer + appearance -------------------------------------------------
  const fogMap = new FogParser.FogMap();
  let fogLayer = null;
  const SWATCHES = ["#2d3a4a", "#7d5a5a", "#6a6f8a", "#c19a4b"];
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
  const hintEl = $("hint"), defogEl = $("defog"), defogFill = $("defogFill"), defogPct = $("defogPct");
  function updateDefog() {
    if (!fogMap.tileCount) { hintEl.style.display = ""; defogEl.style.display = "none"; return; }
    hintEl.style.display = "none"; defogEl.style.display = "flex";
    const b = map.getBounds(), NX = 48, NY = 32;
    const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    let vis = 0, tot = 0;
    for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
      const c = FogParser.lngLatToCell(w + (e - w) * (i + 0.5) / NX, s + (n - s) * (j + 0.5) / NY);
      tot++; if (fogMap.isVisitedCell(Math.floor(c.cx), Math.floor(c.cy))) vis++;
    }
    const pct = tot ? Math.round(100 * vis / tot) : 0;
    defogPct.textContent = pct + "%"; defogFill.style.width = pct + "%";
  }
  map.on("moveend", updateDefog);

  // ---- data loading -----------------------------------------------------------
  const loadStatus = $("loadStatus");
  const setLoad = (m) => { loadStatus.textContent = m; };
  const inflateToTile = (name, buf) => fogMap.addTile(name, pako.inflate(new Uint8Array(buf)));
  function finishLoad() {
    ensureLayer();
    const b = fogMap.latLngBounds();
    if (b) map.fitBounds(b, { padding: [20, 20] });
    setLoad(`${fogMap.tileCount} tiles loaded — nothing left your device.`);
    updateDefog();
  }
  async function loadFromServer() {
    setLoad("Listing /Sync/ …");
    let names;
    try {
      const html = await (await fetch("/Sync/")).text();
      names = [...html.matchAll(/href="([^"?]+)"/g)].map((m) => decodeURIComponent(m[1])).filter((n) => !n.includes("/"));
    } catch (e) { setLoad("Could not list /Sync/. Start the dev server, or use Pick folder."); return; }
    if (!names.length) { setLoad("No files under /Sync/."); return; }
    let ok = 0, i = 0;
    for (const name of names) {
      try { if (inflateToTile(name, await (await fetch("/Sync/" + encodeURIComponent(name))).arrayBuffer())) ok++; } catch (e) {}
      if (++i % 50 === 0) setLoad(`Decoding… ${i}/${names.length}`);
    }
    finishLoad();
  }
  async function loadFromInput(fileList) {
    const files = Array.from(fileList); if (!files.length) return;
    let ok = 0, i = 0;
    for (const f of files) {
      try { if (inflateToTile(f.name, await f.arrayBuffer())) ok++; } catch (e) {}
      if (++i % 50 === 0) setLoad(`Decoding… ${i}/${files.length}`);
    }
    finishLoad();
  }
  $("loadServer").addEventListener("click", loadFromServer);
  $("folder").addEventListener("change", (e) => loadFromInput(e.target.files));

  // ---- route planning ---------------------------------------------------------
  const exportGpxBtn = $("exportGpx"), exportKmlBtn = $("exportKml"), gmapsBtn = $("openGmaps");
  const drawBtn = $("drawToggle"), statsWrap = $("statsWrap"), routeHint = $("routeHint");
  const elevEl = $("elev"), elevHead = $("elevHead"), wpListEl = $("wpList"), wpHead = $("wpHead");
  const ELEV_MODES = new Set(["trekking", "fastbike", "hiking-mountain"]);
  const MODE_LABEL = { trekking: "bike route", fastbike: "road bike route", "hiking-mountain": "walk", "car-fast": "car route", rail: "rail route", shortest: "direct line" };
  const IDLE = "Click the map to drop waypoints. Drag the line to bend the route; click a point to remove it.";
  let profile = "trekking";

  function setExports(routable) {
    exportGpxBtn.disabled = !routable; exportKmlBtn.disabled = !routable;
    gmapsBtn.disabled = route.wps.length < 2;
  }
  function clearRouteInfo(msg) {
    statsWrap.innerHTML = ""; routeHint.textContent = msg; routeHint.style.display = "";
    elevEl.innerHTML = ""; elevHead.style.display = "none";
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
    let emin = Math.min.apply(null, eles), emax = Math.max.apply(null, eles);
    if (emax - emin < 1) emax = emin + 1;
    const x = (d) => padX + (d / total) * (W - 2 * padX);
    const y = (e) => padT + (1 - (e - emin) / (emax - emin)) * (H - padT - padB);
    let path = "M" + x(0) + "," + y(eles[0]);
    for (let i = 1; i < c.length; i++) path += " L" + x(dists[i]) + "," + y(eles[i]);
    const area = path + ` L${x(total)},${H - padB} L${x(0)},${H - padB} Z`;
    elevHead.style.display = "";
    elevEl.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<path d="${area}" fill="#3b4ad922"/>` +
      `<path d="${path}" fill="none" stroke="#3b4ad9" stroke-width="1.6"/>` +
      `<text class="lbl" x="4" y="${H - 4}">${Math.round(emin)} m</text>` +
      `<text class="lbl" x="${W - 4}" y="${H - 4}" text-anchor="end">${Math.round(emax)} m</text>` +
      `</svg>`;
  }

  const route = new RouteTool(map, {
    profile,
    onWaypoints: renderWps,
    onChange: (s) => {
      if (!s) { clearRouteInfo(IDLE); setExports(false); return; }
      if (s.loading) { routeHint.textContent = `Routing ${s.points} waypoints…`; routeHint.style.display = ""; return; }
      if (s.error) { clearRouteInfo("Routing server unreachable — showing a straight line."); setExports(route.routeCoords.length >= 2); return; }
      if (s.km == null) { clearRouteInfo(`${s.points} waypoint${s.points > 1 ? "s" : ""} — add one more to route.`); setExports(false); return; }
      statsWrap.innerHTML =
        `<div class="card"><span class="statbig">${s.km.toFixed(1)} km</span> <span class="statsub">${MODE_LABEL[profile] || ""}</span>` +
        `<div class="statline"><span>↑ ${s.ascent} m</span><span>↓ ${s.descent} m</span><span>~${Math.round(s.seconds / 60)} min</span></div></div>`;
      routeHint.style.display = "none";
      setExports(true); renderElev();
    }
  });

  const modeBtns = document.querySelectorAll("#modes button");
  function setMode(p) {
    profile = p;
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.p === p));
    route.setProfile(p);
  }
  modeBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.p)));
  setMode("trekking");

  drawBtn.addEventListener("click", () => {
    const on = !route.active;
    route.setActive(on);
    drawBtn.textContent = on ? "Stop drawing" : "Start drawing";
    drawBtn.style.background = on ? "#c9384f" : "";
  });
  $("undo").addEventListener("click", () => route.undo());
  $("clear").addEventListener("click", () => route.clear());
  exportGpxBtn.addEventListener("click", () => route.downloadGPX());
  exportKmlBtn.addEventListener("click", () => route.downloadKML());
  gmapsBtn.addEventListener("click", () => { const u = route.googleMapsUrl(); if (u) window.open(u, "_blank", "noopener"); });
})();
