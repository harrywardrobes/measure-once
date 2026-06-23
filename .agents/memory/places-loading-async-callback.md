---
name: Google Maps loading=async requires callback parameter
description: With loading=async, the Maps JS script element onload fires before google.maps.importLibrary is ready — must use callback= URL param instead.
---

## Rule
Never use `script.onload` to detect when `google.maps.importLibrary` is ready when the Maps JS URL includes `loading=async`. Always pass a `callback=` URL parameter.

## Why
With `loading=async`, Google returns a lightweight ~13 KB shim (not the full SDK). That shim injects the real SDK (`main.js`) via a second dynamically-added `<script>` tag. The outer script element's `onload` event fires when the **shim** finishes — before `main.js` has loaded and before `google.maps.importLibrary` exists on `window.google.maps`. Checking for `importLibrary` in `onload` always returns undefined, causing an immediate rejection (`"Places library unavailable after load"`) and setting `acFailed = true` permanently for that page load.

## How to apply
- In `loadPlacesScript` (googleMapsConfig.ts): set `callback: '__googleMapsPlacesReady'` in the URLSearchParams and register `window.__googleMapsPlacesReady = importPlaces` BEFORE injecting the script. The Maps SDK calls this global after the full SDK (including `importLibrary`) is initialised.
- On script `onerror`: remove the `<script>` element from the DOM so a future retry doesn't find a stale element and hang.
- Fast path (when `google.maps.importLibrary` is already present from a previous load): call `importPlaces()` directly — no script injection needed.
- The `testMapsJsBrowserLoad` admin test uses a separate callback name (`__mosMapsTestCb<timestamp>`) — no conflict.
