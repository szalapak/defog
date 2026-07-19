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
    route:     { target: "explored",   style: "tint",       color: "#3a4a5a", alpha: 150 },
    highlight: { target: "explored",   style: "tint",       color: "#8a5a78", alpha: 130 },
    fog:       { target: "unexplored", style: "darken",     color: "#0e1b34", alpha: 150 }
  };
  // muted palette — desaturated so tints don't clash with basemap detail
  const SWATCHES = ["#3a4a5a", "#5a5f66", "#8a5a78", "#6f6a99", "#b08a4f"];

  const saved = JSON.parse(localStorage.getItem("f2m_style") || "null");
  let style = saved || Object.assign({ dilate: 0 }, PRESETS.route);
  if (style.dilate == null) style.dilate = 0;

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

  // ---- export -----------------------------------------------------------------
  const exportNote = document.getElementById("exportNote");
  document.getElementById("exportKml").addEventListener("click", () => {
    if (!fogMap.tileCount) { exportNote.textContent = "Load your Sync data first."; return; }
    const target = document.getElementById("exportWhat").value;
    exportNote.textContent = "Building export…";
    // let the label paint before the (synchronous) build
    setTimeout(() => {
      // export widening is 0: the ~30 m aggregation grid already fills street width,
      // and coarse-cell dilation would merge separate streets together.
      const res = FogExport.toKML(fogMap, map.getBounds(), {
        target, dilate: 0, color: style.color, alpha: style.alpha
      });
      FogExport.download(res.kml, `fogtomaps-${target}.kml`);
      exportNote.textContent =
        `Exported ${res.rects} shapes at ~${res.squareMeters} m detail` +
        (res.cappedAt ? " (view too dense — zoom in for more detail)." : ".");
    }, 20);
  });

  setStatus('Ready. Click "Load my Sync (dev)" or pick your Sync folder.');
})();
