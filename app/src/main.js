// Wires the UI: tabs, fog import + appearance, and route planning.
(function () {
  const statusEl = document.getElementById("status");
  const setStatus = (m) => { statusEl.textContent = m; };

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
  const SWATCHES = ["#3a4a5a", "#5a5f66", "#8a5a78", "#6f6a99", "#b08a4f"];
  const WIDEN_MAX = 4;

  const saved = JSON.parse(localStorage.getItem("f2m_style") || "null");
  let style = saved || { target: "explored", color: "#3a4a5a", alpha: 150, dilate: 1 };
  if (style.dilate == null) style.dilate = 1;
  style.style = "tint"; // flat tint is the only exposed style

  function persist() { localStorage.setItem("f2m_style", JSON.stringify(style)); }
  function ensureLayer() {
    if (!fogLayer) {
      fogLayer = createFogLayer(fogMap, {
        pane: "fog", maxZoom: 19, minZoom: 0, updateWhenIdle: true, style: Object.assign({}, style)
      });
      fogLayer.addTo(map);
    } else {
      fogLayer.setStyle(style);
    }
  }

  const alpha = document.getElementById("alpha");
  const colorPick = document.getElementById("colorPick");
  const swatchBox = document.getElementById("swatches");
  const widenVal = document.getElementById("widenVal");
  const widenMinus = document.getElementById("widenMinus");
  const widenPlus = document.getElementById("widenPlus");

  function syncControls() {
    document.querySelector(`input[name="target"][value="${style.target}"]`).checked = true;
    alpha.value = style.alpha;
    colorPick.value = style.color;
    widenVal.textContent = style.dilate;
    widenMinus.disabled = style.dilate <= 0;
    widenPlus.disabled = style.dilate >= WIDEN_MAX;
    [...swatchBox.children].forEach((s) => s.classList.toggle("active", s.dataset.c === style.color));
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
  alpha.addEventListener("input", () => applyStyle({ alpha: parseInt(alpha.value, 10) }));
  colorPick.addEventListener("input", () => applyStyle({ color: colorPick.value }));
  document.querySelectorAll('input[name="target"]').forEach((r) =>
    r.addEventListener("change", () => applyStyle({ target: r.value })));
  const stepWiden = (d) => applyStyle({ dilate: Math.max(0, Math.min(WIDEN_MAX, style.dilate + d)) });
  widenMinus.addEventListener("click", () => stepWiden(-1));
  widenPlus.addEventListener("click", () => stepWiden(1));
  syncControls();

  // ---- data loading -----------------------------------------------------------
  function inflateToTile(name, buf) { return fogMap.addTile(name, pako.inflate(new Uint8Array(buf))); }
  function finishLoad() {
    ensureLayer();
    const b = fogMap.latLngBounds();
    if (b) map.fitBounds(b, { padding: [20, 20] });
    setStatus(`Loaded ${fogMap.tileCount} tiles.`);
  }
  async function loadFromServer() {
    setStatus("Listing /Sync/ …");
    let names;
    try {
      const html = await (await fetch("/Sync/")).text();
      names = [...html.matchAll(/href="([^"?]+)"/g)]
        .map((m) => decodeURIComponent(m[1])).filter((n) => !n.includes("/"));
    } catch (e) {
      setStatus("Could not list /Sync/. Run: python -m http.server 8000 from the project root."); return;
    }
    if (!names.length) { setStatus("No files under /Sync/."); return; }
    let ok = 0, i = 0;
    for (const name of names) {
      try { if (inflateToTile(name, await (await fetch("/Sync/" + encodeURIComponent(name))).arrayBuffer())) ok++; }
      catch (e) {}
      if (++i % 50 === 0) setStatus(`Decoding… ${i}/${names.length}`);
    }
    setStatus(`Parsed ${ok}/${names.length} files.`); finishLoad();
  }
  async function loadFromInput(fileList) {
    const files = Array.from(fileList); if (!files.length) return;
    let ok = 0, i = 0;
    for (const f of files) {
      try { if (inflateToTile(f.name, await f.arrayBuffer())) ok++; } catch (e) {}
      if (++i % 50 === 0) setStatus(`Decoding… ${i}/${files.length}`);
    }
    setStatus(`Parsed ${ok}/${files.length} files.`); finishLoad();
  }
  document.getElementById("loadServer").addEventListener("click", loadFromServer);
  document.getElementById("folder").addEventListener("change", (e) => loadFromInput(e.target.files));

  // ---- route planning ---------------------------------------------------------
  const exportGpxBtn = document.getElementById("exportGpx");
  const exportKmlBtn = document.getElementById("exportKml");
  const gmapsBtn = document.getElementById("openGmaps");
  const drawBtn = document.getElementById("drawToggle");
  const statsEl = document.getElementById("routeStats");
  const elevEl = document.getElementById("elev");
  const wpListEl = document.getElementById("wpList");
  const ELEV_MODES = new Set(["trekking", "fastbike", "hiking-mountain"]);
  const IDLE = "Click the map to drop waypoints. Drag the line to bend the route; click a point to remove it.";
  let profile = "trekking";

  function setExports(routable) {
    exportGpxBtn.disabled = !routable;
    exportKmlBtn.disabled = !routable;
    gmapsBtn.disabled = route.wps.length < 2;
  }

  function renderWps(list) {
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
    elevEl.innerHTML = "";
    const c = route.routeCoords;
    if (!ELEV_MODES.has(profile) || c.length < 2 || c[0].length < 3) return;
    const W = 272, H = 74, padT = 8, padB = 14, padL = 4, padR = 4;
    const dists = [0]; let total = 0;
    for (let i = 1; i < c.length; i++) {
      total += L.latLng(c[i - 1][1], c[i - 1][0]).distanceTo(L.latLng(c[i][1], c[i][0]));
      dists.push(total);
    }
    if (total < 1) return;
    const eles = c.map((p) => p[2]);
    let emin = Math.min.apply(null, eles), emax = Math.max.apply(null, eles);
    if (emax - emin < 1) emax = emin + 1;
    const x = (d) => padL + (d / total) * (W - padL - padR);
    const y = (e) => padT + (1 - (e - emin) / (emax - emin)) * (H - padT - padB);
    let path = "M" + x(0) + "," + y(eles[0]);
    for (let i = 1; i < c.length; i++) path += " L" + x(dists[i]) + "," + y(eles[i]);
    const area = path + " L" + x(total) + "," + (H - padB) + " L" + x(0) + "," + (H - padB) + " Z";
    elevEl.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<path d="${area}" fill="#3856c933"/>` +
      `<path d="${path}" fill="none" stroke="#3856c9" stroke-width="1.5"/>` +
      `<text class="lbl" x="4" y="10">${Math.round(emax)} m</text>` +
      `<text class="lbl" x="4" y="${H - 3}">${Math.round(emin)} m</text>` +
      `<text class="lbl" x="${W - 4}" y="${H - 3}" text-anchor="end">${(total / 1000).toFixed(1)} km</text>` +
      `</svg>`;
  }

  const route = new RouteTool(map, {
    profile,
    onWaypoints: renderWps,
    onChange: (s) => {
      if (!s) { statsEl.textContent = IDLE; setExports(false); elevEl.innerHTML = ""; return; }
      if (s.loading) { statsEl.textContent = `Routing ${s.points} waypoints…`; return; }
      if (s.error) { statsEl.textContent = "Routing server unreachable — showing a straight line."; setExports(route.routeCoords.length >= 2); elevEl.innerHTML = ""; return; }
      if (s.km == null) { statsEl.textContent = `${s.points} waypoint${s.points > 1 ? "s" : ""} — add one more to route.`; setExports(false); elevEl.innerHTML = ""; return; }
      statsEl.innerHTML = `<b>${s.km.toFixed(1)} km</b> · ↑${s.ascent} m ↓${s.descent} m · ~${Math.round(s.seconds / 60)} min`;
      setExports(true); renderElev();
    }
  });

  // transport modes
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
  document.getElementById("undo").addEventListener("click", () => route.undo());
  document.getElementById("clear").addEventListener("click", () => route.clear());
  exportGpxBtn.addEventListener("click", () => route.downloadGPX());
  exportKmlBtn.addEventListener("click", () => route.downloadKML());
  gmapsBtn.addEventListener("click", () => { const u = route.googleMapsUrl(); if (u) window.open(u, "_blank", "noopener"); });

  setStatus("Ready. On the Fog tab, load your Sync folder.");
})();
