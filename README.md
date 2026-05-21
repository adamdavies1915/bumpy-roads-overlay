# Bumpy Roads Overlay

A tiny browser extension that overlays community road-roughness data from
[bumpyroads.org](https://bumpyroads.org) on top of:

- [bikestreets.com](https://bikestreets.com/la/new-orleans/) — public bike
  routing map (MapLibre)
- The Bike Streets internal **network editor** (iD-based) — **tracks live
  during pan/zoom**
- [openstreetmap.org](https://www.openstreetmap.org/) — main map (Leaflet)
- openstreetmap.org/edit — iD editor — **tracks live during pan/zoom**

Useful for spotting which streets have the worst measured roughness against
existing approved bike-routing networks.

## Install (Chrome / Edge / Brave / Arc)

The extension isn't on the Chrome Web Store. You load it manually — takes
about a minute, no command line needed.

1. **Download the extension.** Click here:
   👉 **[Download ZIP](https://github.com/adamdavies1915/bumpy-roads-overlay/archive/refs/heads/main.zip)**
   (Or do it from the repo page: click the green **"<> Code"** button → **Download ZIP**.)
2. **Unzip it.** Double-click the downloaded file. You'll get a folder named
   `bumpy-roads-overlay-main`. Move it somewhere you won't accidentally delete
   it (your `Documents` folder is fine) — the browser reads the files from
   that folder, so if you trash the folder the extension breaks.
3. **Open your browser's extensions page.** Paste the right URL for your
   browser into the address bar and hit Enter:
   - Chrome: `chrome://extensions/`
   - Brave: `brave://extensions/`
   - Edge: `edge://extensions/`
   - Arc: `arc://extensions/`
4. **Turn on Developer mode** (toggle in the top-right corner of the
   extensions page).
5. **Click "Load unpacked"** (button in the top-left of the extensions page).
   Pick the `bumpy-roads-overlay-main` folder you unzipped in step 2.
6. **Test it.** Visit [[bikestreets.com/la/new-orleans](https://bikestreets.com/la/new-orleans/)](https://bikestreets.com/internal/admin/network/edit)
   and zoom in. Colored squares should fade in over the streets.

That's it. Toggle the overlay on/off with the **Bumpy Roads: On** chip in
the top-right of the map.

### Updating

Re-download the ZIP, unzip it (overwriting the old folder), then go back to
your extensions page and click the **↻ reload** button on the Bumpy Roads
Overlay tile.

## What the colors mean

| Color | Meaning |
|-------|---------|
| 🟢 Green | Smooth |
| 🟡 Yellow-green | Moderate |
| 🟠 Orange | Rough |
| 🔴 Red | Very rough |
| 🔴 Red w/ outlined border | A "rough patch" — one or more cells in the area exceed the rough-patch threshold |

Cells are ~14m squares (the same grid bumpyroads.org uses internally), so on a
typical NOLA city block you'll see ~7–8 cells per street.

## How it works

The whole extension is one content script (`overlay.js`):

1. Finds the host page's map container.
2. Reads zoom & center from the URL hash (every supported site keeps it in
   sync with the map).
3. Fetches tiles from `https://bumpyroads.org/api/tiles/community/{z}/{x}/{y}`.
   The community endpoint is anonymous + CORS-enabled.
4. Paints colored cells on a transparent canvas pinned over the map div using
   standard Web Mercator math — no host-map-library hooks needed.

No frameworks, no bundling, no service worker, no service-worker permissions —
just standard browser APIs. About 600 lines of JS total.

## Pan/zoom tracking

| Surface | Behavior |
|---|---|
| iD editor (bike streets internal + osm.org/edit) | **Live during pan/zoom** — iD writes the URL hash continuously, we poll it at ~7Hz |
| Public bike streets routing map | Snaps on moveend — MapLibre only updates the URL hash when a drag/zoom ends |
| openstreetmap.org main map | Snaps on moveend — Leaflet, same reason |

Live tracking on the MapLibre/Leaflet sites would require access to the map
instance, which is sealed inside an ES-module closure on bike streets and
out of reach for a content script. Snap-on-release is the best we can do
without bike streets exposing the map.

## Pointing at a local dev server

To overlay data from a local `bumpy-roads` dev server instead of production,
open DevTools on any supported site and run:

```js
localStorage.setItem("bumpyOverlay.apiBase", "http://localhost:3001");
location.reload();
```

The extension legend will then show the active API base in its bottom line.
Revert with `localStorage.removeItem("bumpyOverlay.apiBase")`.

## Limitations

- **No rotation/pitch.** If you rotate or tilt the map (bike streets'
  public routing map supports it), the overlay hides itself and asks you
  to reset bearing. Live MapLibre projection would be needed to handle
  rotation correctly, and we don't have access to the map instance.
- **Bing satellite imagery offset.** Bike streets renders OSM data over
  Bing satellite tiles, which can be 5–20m off from OSM in city centers.
  Cells align with OSM coordinates (the blue route lines), not with
  visible buildings on Bing.
- **Color thresholds are hard-coded.** Mirrors `ROUGHNESS_THRESHOLDS` and
  `ROUGH_PATCH_THRESHOLD_RAW` from the bumpy-roads source. Keep them in
  sync if those move.

## Files

- `manifest.json` — Manifest V3.
- `overlay.js` — content script (the whole feature).
- `overlay.css` — legend / toggle styles.
- `popup.html` — toolbar popup with usage notes.

## License

MIT — see `LICENSE`.
