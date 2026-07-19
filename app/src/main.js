// Wires the UI: load Sync data, render the fog overlay, customise the look.
(function () {
  const statusEl = document.getElementById("status");
  const setStatus = (m) => { statusEl.textContent = m; };

  const map = L.map("map", { center: [50, 15], zoom: 4, worldCopyJump: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // dedicated pane so the fog blends against the basemap while staying above it
  map.createPane("fog");
  map.getPane("fog").style.zIndex = 350;

  const fogMap = new FogParser.FogMap();
  let fogLayer = null;

  // ---- style presets ----------------------------------------------------------
  const PRESETS = {
    route: { target: "explored",   style: "tint",   color: "#3a4a5a", alpha: 150 },
    fog:   { target: "unexplored", style: "darken", color: "#0e1b34", alpha: 150 }
  };
  // muted palette — desaturated so tints don't clash with basemap detail
  const SWATCHES = ["#3a4a5a", "#5a5f66", "#8a5a78", "#6f6a99", "#b08a4f"];

  const saved = JSON.parse(localStorage.getItem("f2m_style") || "null");
  let style = saved || Object.assign({ dilate: 1 }, PRESETS.route);
  if (style.dilate == null) style.dilate = 1;

  function persist() { localStorage.setItem("f2m_style", JSON.stringify(style)); }

  function ensureLayer() {
    if (!fogLayer) {
      fogLayer = createFogLayer(fogMap, {
        pane: "fog", maxZoom: 19, minZoom: 0, updateWhenIdle: true,
        style: Object.assign({}, style)
      });
      fogLayer.addTo(map);
    } else {
      fogLayer.setStyle(style);
    }
  }

  // ---- look panel controls ----------------------------------------------------
  const presetSel = document.getElementById("preset");
  const styleSel = document.getElementById("styleSel");
  const alpha = document.getElementById("alpha");
  const colorPick = document.getElementById("colorPick");
  const swatchBox = document.getElementById("swatches");
  const widenVal = document.getElementById("widenVal");
  const widenMinus = document.getElementById("widenMinus");
  const widenPlus = document.getElementById("widenPlus");
  const WIDEN_MAX = 4;

  function syncControls() {
    document.querySelector(`input[name="target"][value="${style.target}"]`).checked = true;
    styleSel.value = style.style;
    alpha.value = style.alpha;
    widenVal.textContent = style.dilate;
    widenMinus.disabled = style.dilate <= 0;
    widenPlus.disabled = style.dilate >= WIDEN_MAX;
    colorPick.value = style.color;
    document.getElementById("colorRow").style.display = style.style === "desaturate" ? "none" : "";
    [...swatchBox.children].forEach((s) => s.classList.toggle("active", s.dataset.c === style.color));
  }
  function applyStyle(patch, redrawPreset) {
    Object.assign(style, patch);
    if (redrawPreset) presetSel.value = redrawPreset;
    persist();
    syncControls();
    if (fogLayer) fogLayer.setStyle(style);
  }

  SWATCHES.forEach((c) => {
    const s = document.createElement("span");
    s.className = "sw"; s.style.background = c; s.dataset.c = c;
    s.addEventListener("click", () => applyStyle({ color: c }));
    swatchBox.appendChild(s);
  });
  presetSel.addEventListener("change", () => applyStyle(Object.assign({}, PRESETS[presetSel.value])));
  styleSel.addEventListener("change", () => applyStyle({ style: styleSel.value }));
  alpha.addEventListener("input", () => applyStyle({ alpha: parseInt(alpha.value, 10) }));
  const stepWiden = (d) => applyStyle({ dilate: Math.max(0, Math.min(WIDEN_MAX, style.dilate + d)) });
  widenMinus.addEventListener("click", () => stepWiden(-1));
  widenPlus.addEventListener("click", () => stepWiden(1));
  colorPick.addEventListener("input", () => applyStyle({ color: colorPick.value }));
  document.querySelectorAll('input[name="target"]').forEach((r) =>
    r.addEventListener("change", () => applyStyle({ target: r.value })));

  // collapsible panels
  document.querySelectorAll("h3[data-toggle]").forEach((h) =>
    h.addEventListener("click", () => document.getElementById(h.dataset.toggle).classList.toggle("collapsed")));

  // stop panel interactions (slider drags, clicks, scroll) from panning/zooming the map
  document.querySelectorAll(".panel").forEach((p) => {
    L.DomEvent.disableClickPropagation(p);
    L.DomEvent.disableScrollPropagation(p);
  });

  syncControls();

  // ---- data loading -----------------------------------------------------------
  function inflateToTile(name, buf) {
    return fogMap.addTile(name, pako.inflate(new Uint8Array(buf)));
  }
  function finishLoad() {
    ensureLayer();
    const b = fogMap.latLngBounds();
    if (b) map.fitBounds(b, { padding: [20, 20] });
    setStatus(`Loaded ${fogMap.tileCount} tiles. Zoom in; unexplored streets stay crisp.`);
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

  // ---- route planning (BRouter) ----------------------------------------------
  const exportBtn = document.getElementById("exportGpx");
  const drawBtn = document.getElementById("drawToggle");
  const statsEl = document.getElementById("routeStats");
  const profileSel = document.getElementById("profile");
  const IDLE = "Click the map to drop waypoints. Drag the line to bend the route; click a point to remove it.";

  const wpListEl = document.getElementById("wpList");
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

  const route = new RouteTool(map, {
    profile: profileSel.value,
    onWaypoints: renderWps,
    onChange: (s) => {
      if (!s) { statsEl.textContent = IDLE; exportBtn.disabled = true; return; }
      if (s.loading) { statsEl.textContent = `Routing ${s.points} waypoints…`; return; }
      if (s.error) { statsEl.textContent = "Routing server unreachable — showing a straight line."; exportBtn.disabled = route.routeCoords.length < 2; return; }
      if (s.km == null) { statsEl.textContent = `${s.points} waypoint${s.points > 1 ? "s" : ""} — add one more to route.`; exportBtn.disabled = true; return; }
      statsEl.innerHTML = `<b>${s.km.toFixed(1)} km</b> · ↑${s.ascent} m ↓${s.descent} m · ~${Math.round(s.seconds / 60)} min`;
      exportBtn.disabled = false;
    }
  });
  profileSel.addEventListener("change", () => route.setProfile(profileSel.value));
  drawBtn.addEventListener("click", () => {
    const on = !route.active;
    route.setActive(on);
    drawBtn.textContent = on ? "Stop drawing" : "Start drawing";
    drawBtn.style.background = on ? "#c9384f" : "";
  });
  document.getElementById("undo").addEventListener("click", () => route.undo());
  document.getElementById("clear").addEventListener("click", () => route.clear());
  exportBtn.addEventListener("click", () => route.downloadGPX());

  setStatus('Ready. Click "Load my Sync (dev)" or pick your Sync folder.');
})();
