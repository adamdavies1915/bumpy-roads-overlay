// Bumpy Roads Overlay
//
// Pins a transparent canvas on top of the host site's map container and
// renders community roughness cells fetched from bumpyroads.org. We don't
// hook the host map library — instead, we parse zoom/center from the URL
// hash (which both bikestreets and openstreetmap.org keep in sync with the
// map) and project cells with our own Web Mercator math. Trade-off: the
// overlay snaps into place after a drag rather than tracking it live.

(function () {
  "use strict";

  // Override at runtime (for local dev) by running this in the page console,
  // then reloading:
  //   localStorage.setItem("bumpyOverlay.apiBase", "http://localhost:3001")
  const DEFAULT_API_BASE = "https://bumpyroads.org";
  const API_BASE_KEY = "bumpyOverlay.apiBase";
  const STORAGE_KEY = "bumpyOverlay.enabled.v1";

  function readApiBase() {
    try {
      const v = localStorage.getItem(API_BASE_KEY);
      if (v && /^https?:\/\//.test(v)) return v.replace(/\/$/, "");
    } catch {
      /* ignore */
    }
    return DEFAULT_API_BASE;
  }

  const API_BASE = readApiBase();

  function escapeHost(url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  const TILE_SIZE = 256;
  const MIN_RENDER_ZOOM = 12;
  const MAX_NATIVE_ZOOM = 18;

  // Color thresholds — mirror src/lib/constants.ts. Keep these in sync
  // manually; the extension ships standalone without bundling app code.
  const THRESHOLDS = { smooth: 3.0, moderate: 5.3, rough: 9.0 };
  const ROUGH_PATCH_THRESHOLD = 9.0;
  const GRID_SIZE = 0.000125;
  const COLORS = ["#6BAF6E", "#89B86A", "#CC8832", "#A83232"];

  function roughnessColor(v) {
    if (v < THRESHOLDS.smooth) return COLORS[0];
    if (v < THRESHOLDS.moderate) return COLORS[1];
    if (v < THRESHOLDS.rough) return COLORS[2];
    return COLORS[3];
  }

  // Geometric mean — see roughnessCombined() in src/lib/constants.ts.
  function roughnessCombined(mad, lpc) {
    if (lpc == null) return mad;
    return Math.sqrt(mad * lpc);
  }

  // Slippy-map / Web Mercator at pixel granularity. 1 tile = TILE_SIZE px.
  function projectPx(lat, lng, zoom) {
    const n = TILE_SIZE * Math.pow(2, zoom);
    const x = ((lng + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
    return { x, y };
  }

  function lngLatToTile(lng, lat, z) {
    const n = Math.pow(2, z);
    const x = Math.floor(((lng + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
    return { x, y };
  }

  function tileToBbox(z, x, y) {
    const n = Math.pow(2, z);
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
    return { south, west, north, east };
  }

  // Hash parsers, shared across adapters.
  //
  // MapLibre/Mapbox hash plugin format: #zoom/lat/lng[/bearing/pitch]
  function parseMaplibreHash(hash) {
    const m = hash.replace(/^#/, "").split("/");
    if (m.length < 3) return null;
    const z = parseFloat(m[0]);
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const bearing = m.length > 3 ? parseFloat(m[3]) : 0;
    const pitch = m.length > 4 ? parseFloat(m[4]) : 0;
    if (!Number.isFinite(z) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    return { zoom: z, lat, lng, bearing: bearing || 0, pitch: pitch || 0 };
  }
  // OSM / iD hash format: #...&map=zoom/lat/lng (with any leading &-separated keys).
  function parseOsmHash(hash) {
    const m = /map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(hash);
    if (!m) return null;
    return {
      zoom: parseFloat(m[1]),
      lat: parseFloat(m[2]),
      lng: parseFloat(m[3]),
      bearing: 0,
      pitch: 0,
    };
  }

  // Site adapters: how to find the map container and parse zoom/center.
  // Order matters — more specific matches first.
  const SITES = {
    // Bikestreets internal network editor — uses iD (OSM editor). iD updates
    // the URL hash continuously during pan, so the overlay tracks smoothly.
    bikestreetsEdit: {
      match: () =>
        location.hostname === "bikestreets.com" &&
        location.pathname.includes("/internal/admin/network/edit"),
      // iD's `.supersurface` is the only element whose bounding rect matches
      // the visible map area (sidebar excluded). Return null until it exists
      // so `waitFor` keeps polling rather than caching the outer
      // `#id-container` (which includes the sidebar).
      container: () => document.querySelector("#id-container .supersurface"),
      parseHash: parseOsmHash,
      liveHash: true,
    },
    // openstreetmap.org/edit — also iD.
    osmEdit: {
      match: () =>
        location.hostname.endsWith("openstreetmap.org") &&
        location.pathname.startsWith("/edit"),
      container: () => document.querySelector("#id-container .supersurface"),
      parseHash: parseOsmHash,
      liveHash: true,
    },
    // Public bikestreets routing map — MapLibre, ESM-imported so the map
    // instance is sealed inside its module closure (no global, no DOM
    // backlink, search-box doesn't expose it). We're stuck with URL-hash
    // polling, which only updates on `moveend` — overlay snaps after release.
    bikestreets: {
      match: () => location.hostname === "bikestreets.com",
      container: () => document.getElementById("map"),
      parseHash: parseMaplibreHash,
      liveHash: false,
    },
    // Public OSM main map — Leaflet, hash only on moveend.
    osm: {
      match: () => location.hostname.endsWith("openstreetmap.org"),
      container: () => document.getElementById("map"),
      parseHash: parseOsmHash,
      liveHash: false,
    },
  };

  const site = Object.values(SITES).find((s) => s.match());
  if (!site) return; // Should be filtered by manifest matches, but defensive.

  const tileCache = new Map(); // key "z/x/y" -> { gridSize, cells }
  const inflight = new Map(); // key -> AbortController
  let canvas = null;
  let ctx = null;
  let legend = null;
  let toggle = null;
  let container = null;
  let resizeObserver = null;
  let attribution = null;
  let enabled = readEnabled();
  let redrawPending = false;

  function readEnabled() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  }

  function writeEnabled(v) {
    try {
      localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      /* quota errors are non-fatal */
    }
  }

  function waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const v = predicate();
        if (v) return resolve(v);
        if (timeoutMs && Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function mountCanvas() {
    if (!container || canvas) return;
    canvas = document.createElement("canvas");
    canvas.className = "bumpy-overlay-canvas";
    container.appendChild(canvas);
    ctx = canvas.getContext("2d");
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function mountChrome() {
    if (!container || legend) return;

    legend = document.createElement("div");
    legend.className = "bumpy-overlay-legend";
    legend.innerHTML = `
      <strong>Bumpy Roads</strong>
      <div class="row"><span class="swatch" style="background:${COLORS[0]}"></span>Smooth</div>
      <div class="row"><span class="swatch" style="background:${COLORS[1]}"></span>Moderate</div>
      <div class="row"><span class="swatch" style="background:${COLORS[2]}"></span>Rough</div>
      <div class="row"><span class="swatch" style="background:${COLORS[3]}"></span>Very rough</div>
      <div class="muted" data-bumpy-status>Loading…</div>
      <div class="muted" data-bumpy-api>${escapeHost(API_BASE)}</div>
    `;
    container.appendChild(legend);

    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "bumpy-overlay-toggle";
    toggle.textContent = enabled ? "Bumpy Roads: On" : "Bumpy Roads: Off";
    if (!enabled) toggle.classList.add("is-off");
    toggle.addEventListener("click", () => {
      enabled = !enabled;
      writeEnabled(enabled);
      toggle.textContent = enabled ? "Bumpy Roads: On" : "Bumpy Roads: Off";
      toggle.classList.toggle("is-off", !enabled);
      if (enabled) {
        scheduleRefresh();
      } else if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    });
    container.appendChild(toggle);
  }

  function setStatus(text) {
    if (!legend) return;
    const el = legend.querySelector("[data-bumpy-status]");
    if (el) el.textContent = text;
  }

  function scheduleRefresh() {
    if (redrawPending) return;
    redrawPending = true;
    requestAnimationFrame(() => {
      redrawPending = false;
      refresh();
    });
  }

  // The tile API serves data at a small set of LOD zooms (12-18). Pick the
  // closest one at-or-below the host map's display zoom.
  function fetchZoom(z) {
    const rounded = Math.floor(z);
    if (rounded < MIN_RENDER_ZOOM) return null;
    if (rounded > MAX_NATIVE_ZOOM) return MAX_NATIVE_ZOOM;
    return rounded;
  }

  async function fetchTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    if (inflight.has(key)) return null;

    const controller = new AbortController();
    inflight.set(key, controller);
    try {
      const url = `${API_BASE}/api/tiles/community/${z}/${x}/${y}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const data = await res.json();
      tileCache.set(key, data);
      // Cheap LRU: cap cache size.
      if (tileCache.size > 256) {
        const first = tileCache.keys().next().value;
        tileCache.delete(first);
      }
      return data;
    } catch (err) {
      if (err && err.name !== "AbortError") {
        console.warn("[Bumpy Roads] tile fetch failed", err);
      }
      return null;
    } finally {
      inflight.delete(key);
    }
  }

  function visibleTiles(view, z) {
    const tl = lngLatToTile(view.west, view.north, z);
    const br = lngLatToTile(view.east, view.south, z);
    const tiles = [];
    for (let x = tl.x; x <= br.x; x++) {
      for (let y = tl.y; y <= br.y; y++) {
        tiles.push({ x, y });
      }
    }
    return tiles;
  }

  function bboxFromCenter(center, sizePx, zoom) {
    // Convert pixel viewport to lat/lng bbox by projecting corners.
    const c = projectPx(center.lat, center.lng, zoom);
    const halfW = sizePx.w / 2;
    const halfH = sizePx.h / 2;
    const tl = unproject({ x: c.x - halfW, y: c.y - halfH }, zoom);
    const br = unproject({ x: c.x + halfW, y: c.y + halfH }, zoom);
    return { north: tl.lat, west: tl.lng, south: br.lat, east: br.lng };
  }

  function unproject(px, zoom) {
    const n = TILE_SIZE * Math.pow(2, zoom);
    const lng = (px.x / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * px.y) / n)));
    const lat = (latRad * 180) / Math.PI;
    return { lat, lng };
  }

  function drawCells(view, zoom, sizePx, tiles) {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, sizePx.w, sizePx.h);
    if (!enabled) return;

    const centerPx = projectPx(view.center.lat, view.center.lng, zoom);
    const offsetX = sizePx.w / 2 - centerPx.x;
    const offsetY = sizePx.h / 2 - centerPx.y;

    let drawn = 0;
    for (const t of tiles) {
      const key = `${t.z}/${t.x}/${t.y}`;
      const tile = tileCache.get(key);
      if (!tile) continue;
      const halfDeg = tile.gridSize / 2;
      for (const cell of tile.cells) {
        const [lat, lng, avg, max, avgLpc, maxLpc] = cell;
        const combinedAvg = roughnessCombined(avg, avgLpc);
        const combinedMax = roughnessCombined(max, maxLpc);
        const isCoarse = tile.gridSize > GRID_SIZE * 1.5; // mirrors app's isCoarse heuristic
        const color = roughnessColor(isCoarse ? combinedMax : combinedAvg);
        const isRoughPatch = combinedMax >= ROUGH_PATCH_THRESHOLD;

        const swPx = projectPx(lat - halfDeg, lng - halfDeg, zoom);
        const nePx = projectPx(lat + halfDeg, lng + halfDeg, zoom);
        const x = Math.min(swPx.x, nePx.x) + offsetX;
        const y = Math.min(swPx.y, nePx.y) + offsetY;
        const w = Math.max(1, Math.abs(nePx.x - swPx.x));
        const h = Math.max(1, Math.abs(swPx.y - nePx.y));

        // Skip cells outside the viewport (cheap culling).
        if (x + w < 0 || y + h < 0 || x > sizePx.w || y > sizePx.h) continue;

        ctx.globalAlpha = isRoughPatch ? 0.85 : 0.55;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);

        if (isRoughPatch) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "#FF4444";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        }
        drawn++;
      }
    }
    ctx.globalAlpha = 1;
    setStatus(drawn > 0 ? `${drawn} cells` : "No data here");
  }

  // During iD's smooth-zoom (mouse-wheel) animation, `.supersurface` gets a
  // non-identity CSS transform. Since our canvas is parented inside it, our
  // content would be scaled too — but our cells were drawn at the *new* zoom
  // already, so they'd appear oversized until iD settles. Hiding the canvas
  // during the transition (~200ms) is much better than a stretched overlay.
  function isMidZoomTransition() {
    if (!container) return false;
    const t = getComputedStyle(container).transform;
    if (!t || t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)") return false;
    return true;
  }

  async function refresh() {
    if (!container || !ctx || !canvas) return;
    const hash = site.parseHash(location.hash);
    if (!hash) {
      setStatus("Awaiting map…");
      return;
    }
    if (isMidZoomTransition()) {
      clearOverlay();
      // Re-check shortly — supersurface usually settles within ~150ms.
      setTimeout(scheduleRefresh, 180);
      return;
    }
    if (hash.bearing !== 0 || hash.pitch !== 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setStatus("Rotation not supported — reset bearing");
      return;
    }
    const fetchZ = fetchZoom(hash.zoom);
    if (fetchZ == null) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setStatus("Zoom in to see road quality");
      return;
    }
    resizeCanvas();
    const rect = container.getBoundingClientRect();
    const sizePx = { w: rect.width, h: rect.height };
    const view = bboxFromCenter({ lat: hash.lat, lng: hash.lng }, sizePx, hash.zoom);
    view.center = { lat: hash.lat, lng: hash.lng };

    const tilesXY = visibleTiles(view, fetchZ);
    const tiles = tilesXY.map((t) => ({ ...t, z: fetchZ }));

    // Draw any cached tiles immediately for a responsive feel.
    drawCells(view, hash.zoom, sizePx, tiles);

    const missing = tiles.filter((t) => !tileCache.has(`${t.z}/${t.x}/${t.y}`));
    if (missing.length === 0) {
      ensureAttribution();
      return;
    }

    if (enabled) setStatus("Fetching…");
    await Promise.allSettled(missing.map((t) => fetchTile(t.z, t.x, t.y)));
    // Re-read hash in case the user kept moving while tiles were in flight.
    const after = site.parseHash(location.hash);
    if (!after) return;
    drawCells(view, after.zoom, sizePx, tiles);
    ensureAttribution();
  }

  function ensureAttribution() {
    if (attribution || !container) return;
    // Tiny attribution / link so users know where the data comes from.
    attribution = document.createElement("a");
    attribution.href = `${API_BASE}/map`;
    attribution.target = "_blank";
    attribution.rel = "noopener noreferrer";
    attribution.textContent = "data: bumpyroads.org";
    attribution.style.cssText = [
      "position:absolute",
      "bottom:6px",
      "right:6px",
      "z-index:6",
      "padding:2px 6px",
      "border-radius:4px",
      "background:rgba(255,255,255,0.85)",
      "color:#333",
      "font:10px -apple-system,sans-serif",
      "text-decoration:none",
      "pointer-events:auto",
    ].join(";");
    container.appendChild(attribution);
  }

  // Host map libraries (MapLibre/Mapbox GL) only update the URL hash at
  // `moveend`, not during a drag/zoom. Without access to the map instance we
  // can't follow live, so the next-best thing is to hide the overlay the
  // instant the user starts interacting and redraw when they release — much
  // less jarring than stale cells sliding around.
  let interactingUntil = 0;
  function clearOverlay() {
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  }

  function markInteracting(durationMs) {
    interactingUntil = Date.now() + durationMs;
    clearOverlay();
    setStatus("Panning…");
  }

  function settleAndRefresh() {
    // Give the host map a tick to commit the new center to the URL hash
    // (which then fires our hashchange listener). This is a safety net if it
    // doesn't.
    setTimeout(() => {
      if (Date.now() >= interactingUntil) scheduleRefresh();
    }, 220);
  }

  function attachInteractionListeners(el) {
    // Sites with live-updating hashes (iD-based editors) don't need the
    // hide-during-pan dance — `hashchange` fires continuously, so we already
    // track smoothly. Hiding would cause flicker.
    if (site.liveHash) return;
    el.addEventListener("mousedown", () => markInteracting(500), { passive: true });
    el.addEventListener("touchstart", () => markInteracting(500), { passive: true });
    el.addEventListener("wheel", () => {
      markInteracting(400);
      settleAndRefresh();
    }, { passive: true });
    window.addEventListener("mouseup", settleAndRefresh, { passive: true });
    window.addEventListener("touchend", settleAndRefresh, { passive: true });
  }

  // iD updates the URL via history.replaceState, which silently bypasses the
  // `hashchange` event. We can't reach the page's `history` from the isolated
  // content-script world to wrap it, so we poll instead. 150ms is well under
  // human pan-perception threshold and ~7Hz of `===` comparisons on a 50-byte
  // string is free.
  function startHashPoll() {
    let lastHash = location.hash;
    setInterval(() => {
      if (location.hash !== lastHash) {
        lastHash = location.hash;
        scheduleRefresh();
      }
    }, 150);
  }

  async function boot() {
    container = await waitFor(site.container, 15000);
    if (!container) {
      console.warn("[Bumpy Roads] map container not found on this page");
      return;
    }
    // Ensure the host container is positioned so our absolute overlay stacks
    // inside it correctly.
    const cs = getComputedStyle(container);
    if (cs.position === "static") {
      container.style.position = "relative";
    }
    mountCanvas();
    mountChrome();
    resizeObserver = new ResizeObserver(() => scheduleRefresh());
    resizeObserver.observe(container);
    window.addEventListener("resize", scheduleRefresh);

    window.addEventListener("hashchange", scheduleRefresh);
    attachInteractionListeners(container);
    if (site.liveHash) startHashPoll();
    scheduleRefresh();
  }

  // Don't block page load — boot in the background.
  boot();
})();
