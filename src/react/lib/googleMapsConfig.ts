/**
 * googleMapsConfig.ts — client runtime config + lazy Places JS loader.
 *
 * Mirrors the cached-fetch pattern of searchSettings.ts. The config is served
 * by the public `GET /api/google-maps/config` endpoint, so it also works on the
 * unauthenticated customer-info form. Nothing here is bundled into the heavy
 * Google JS — the Places library is injected into the DOM at runtime only when
 * a surface actually needs it, keeping it out of the main bundle.
 */

export type GoogleMapsSurface =
  | 'customerInfo'
  | 'designVisit'
  | 'arrangeVisit'
  | 'contactEdit'
  | 'genericVisit';

export interface GoogleMapsSurfaceFlags {
  autocomplete: boolean;
  mapPreview: boolean;
}

export interface GoogleMapsConfig {
  enabled: boolean;
  apiKey: string | null;
  autocomplete: {
    countries: string[];
    language: string;
    types: 'address' | 'establishment' | 'geocode';
    debounceMs: number;
    minChars: number;
    sessionTokens: boolean;
  };
  surfaces: Record<GoogleMapsSurface, GoogleMapsSurfaceFlags>;
  mapPreview: {
    enabled: boolean;
    zoom: number;
    mapType: 'roadmap' | 'satellite' | 'hybrid' | 'terrain';
  };
  fallback: {
    mode: 'silent' | 'notice';
    allowManualEntry: boolean;
  };
}

const DISABLED_CONFIG: GoogleMapsConfig = {
  enabled: false,
  apiKey: null,
  autocomplete: {
    countries: ['GB'],
    language: 'en-GB',
    types: 'address',
    debounceMs: 300,
    minChars: 3,
    sessionTokens: true,
  },
  surfaces: {
    customerInfo: { autocomplete: true, mapPreview: true },
    designVisit: { autocomplete: true, mapPreview: true },
    arrangeVisit: { autocomplete: true, mapPreview: true },
    contactEdit: { autocomplete: true, mapPreview: true },
    genericVisit: { autocomplete: true, mapPreview: false },
  },
  mapPreview: { enabled: true, zoom: 15, mapType: 'roadmap' },
  fallback: { mode: 'silent', allowManualEntry: true },
};

let _cached: GoogleMapsConfig | null = null;
let _inFlight: Promise<GoogleMapsConfig> | null = null;

/** Fetch (and cache) the runtime Google Maps config. Never rejects. */
export function loadGoogleMapsConfig(): Promise<GoogleMapsConfig> {
  if (_cached) return Promise.resolve(_cached);
  if (_inFlight) return _inFlight;
  _inFlight = fetch('/api/google-maps/config', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : DISABLED_CONFIG))
    .catch(() => DISABLED_CONFIG)
    .then((data: GoogleMapsConfig) => {
      _cached = { ...DISABLED_CONFIG, ...data };
      _inFlight = null;
      return _cached;
    });
  return _inFlight;
}

/** Drop the cached config so the next load re-fetches (e.g. after admin save). */
export function invalidateGoogleMapsConfig(): void {
  _cached = null;
  _inFlight = null;
}

/**
 * Fire-and-forget usage beacon so the admin diagnostics reflect real
 * client-side Google traffic (autocomplete / place-details / static-map). Never
 * throws and never blocks the UI.
 */
export function reportGoogleMapsUsage(
  api: 'autocomplete' | 'details' | 'staticmap',
  surface: GoogleMapsSurface,
  ok: boolean,
  errorCode?: string,
): void {
  try {
    const body = JSON.stringify({ api, surface, ok, errorCode });
    const nav = navigator as Navigator & {
      sendBeacon?: (url: string, data?: BodyInit) => boolean;
    };
    if (typeof nav.sendBeacon === 'function') {
      nav.sendBeacon('/api/google-maps/usage', new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch('/api/google-maps/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never throw from a beacon */
  }
}

/** True when autocomplete is enabled both globally and for the given surface. */
export function isAutocompleteEnabled(cfg: GoogleMapsConfig, surface: GoogleMapsSurface): boolean {
  return !!cfg.enabled && !!cfg.apiKey && !!cfg.surfaces?.[surface]?.autocomplete;
}

/** True when the static map preview is enabled globally and for the surface. */
export function isMapPreviewEnabled(cfg: GoogleMapsConfig, surface: GoogleMapsSurface): boolean {
  return (
    !!cfg.enabled &&
    !!cfg.apiKey &&
    !!cfg.mapPreview?.enabled &&
    !!cfg.surfaces?.[surface]?.mapPreview
  );
}

// ── Lazy Places JS loader ─────────────────────────────────────────────────────
let _scriptPromise: Promise<void> | null = null;

// Stable global callback name used by the Maps JS bootstrap.
const MAPS_CALLBACK = '__googleMapsPlacesReady';

/**
 * Inject the Google Maps JS API bootstrap (v=weekly, loading=async) once, then
 * call `google.maps.importLibrary('places')` to pull in the new Places API
 * (`AutocompleteSuggestion`, `Place`, etc.). Resolves when
 * `google.maps.places` is available; rejects on load error or timeout so
 * callers can degrade gracefully.
 *
 * IMPORTANT: with loading=async Google returns a lightweight 13 KB shim that
 * injects the real SDK (main.js) via a second dynamically-added script tag.
 * The outer script element's `onload` fires when the *shim* loads, before
 * google.maps.importLibrary exists.  We therefore use the `callback` URL
 * parameter so Google calls us only after the full SDK — including
 * importLibrary — is initialised.
 */
export function loadPlacesScript(apiKey: string, language = 'en-GB'): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  const w = window as unknown as Record<string, unknown> & {
    google?: { maps?: { places?: unknown; importLibrary?: (lib: string) => Promise<unknown> } };
  };
  if (w.google?.maps?.places) return Promise.resolve();
  if (_scriptPromise) return _scriptPromise;

  _scriptPromise = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      _scriptPromise = null;
      delete w[MAPS_CALLBACK];
      reject(new Error('Places JS load timed out'));
    }, 12000);

    const importPlaces = () => {
      const importLibrary = w.google?.maps?.importLibrary;
      if (typeof importLibrary !== 'function') {
        window.clearTimeout(timeout);
        _scriptPromise = null;
        reject(new Error('Places library unavailable after load'));
        return;
      }
      importLibrary('places')
        .then(() => {
          window.clearTimeout(timeout);
          resolve();
        })
        .catch(() => {
          window.clearTimeout(timeout);
          _scriptPromise = null;
          reject(new Error('Places library failed to import'));
        });
    };

    // Fast path: the full SDK is already loaded (e.g. another surface loaded
    // it earlier in this session).
    if (w.google?.maps?.importLibrary) {
      importPlaces();
      return;
    }

    // If there is a stale script element from a previous failed attempt,
    // remove it so we can inject a fresh one with a fresh callback.
    const stale = document.getElementById('google-maps-places-js');
    if (stale) stale.remove();

    // Register the global callback BEFORE injecting the script so it is
    // available the instant the SDK calls it.
    w[MAPS_CALLBACK] = () => {
      delete w[MAPS_CALLBACK];
      importPlaces();
    };

    const script = document.createElement('script');
    script.id = 'google-maps-places-js';
    script.async = true;
    const params = new URLSearchParams({
      key: apiKey,
      v: 'weekly',
      loading: 'async',
      language,
      // The callback param tells the Maps SDK to invoke this global function
      // once it is fully initialised — after importLibrary is ready.
      callback: MAPS_CALLBACK,
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.onerror = () => {
      window.clearTimeout(timeout);
      _scriptPromise = null;
      script.remove();
      delete w[MAPS_CALLBACK];
      reject(new Error('Places JS failed to load'));
    };
    document.head.appendChild(script);
  });
  return _scriptPromise;
}

/**
 * One-shot browser-side load test for the Maps JavaScript API.
 * Intended exclusively for the admin Test Connection panel — not for production
 * autocomplete surfaces.
 *
 * HTTP-referrer and key restrictions only fire when the browser loads the
 * script, so a server-side check can pass while the browser load is still
 * blocked. This function surfaces that gap by actually attempting the load.
 *
 * - If the Maps JS bootstrap is already in the page (loaded by a live surface)
 *   it calls `importLibrary('maps')` to confirm the loaded instance works.
 * - Otherwise it injects a temporary script tag, waits for load/error, then
 *   cleans up regardless of outcome.
 */
export async function testMapsJsBrowserLoad(apiKey: string): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
  reason?: string;
}> {
  if (typeof window === 'undefined') {
    return { ok: false, latencyMs: 0, error: 'No browser window available' };
  }

  const w = window as unknown as {
    google?: { maps?: { importLibrary?: (lib: string) => Promise<unknown> } };
    [key: string]: unknown;
  };

  const t0 = Date.now();

  // Fast path: Maps JS bootstrap already loaded — just confirm importLibrary works.
  if (typeof w.google?.maps?.importLibrary === 'function') {
    try {
      await w.google.maps.importLibrary('maps');
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        error: 'Maps library import failed',
        reason: 'restriction',
      };
    }
  }

  // Slow path: inject a test script tag and wait for it to load or fail.
  // Use a unique callback name and a distinct element id so this does not
  // collide with the production google-maps-places-js script.
  const CALLBACK = '__mosMapsTestCb' + Date.now();
  const SCRIPT_ID = 'google-maps-test-js';

  return new Promise((resolve) => {
    let settled = false;

    const settle = (result: { ok: boolean; latencyMs: number; error?: string; reason?: string }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      delete (w as Record<string, unknown>)[CALLBACK];
      const el = document.getElementById(SCRIPT_ID);
      if (el) el.remove();
      resolve(result);
    };

    const timer = window.setTimeout(() => {
      settle({
        ok: false,
        latencyMs: Date.now() - t0,
        error: 'Maps JS load timed out — check referrer or key restrictions',
        reason: 'restriction',
      });
    }, 12_000);

    // The Maps JS bootstrap calls this global when it is ready.
    (w as Record<string, unknown>)[CALLBACK] = () => {
      settle({ ok: true, latencyMs: Date.now() - t0 });
    };

    // Remove any leftover test element before injecting a fresh one.
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) existing.remove();

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    const params = new URLSearchParams({
      key: apiKey,
      v: 'weekly',
      loading: 'async',
      callback: CALLBACK,
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.onerror = () => {
      settle({
        ok: false,
        latencyMs: Date.now() - t0,
        error: 'Maps JS script failed to load — check referrer or key restrictions',
        reason: 'restriction',
      });
    };
    document.head.appendChild(script);
  });
}

/** Build a Google Static Maps URL for a formatted address string. */
export function staticMapUrl(
  cfg: GoogleMapsConfig,
  address: string,
  opts: { width?: number; height?: number; scale?: number } = {},
): string | null {
  if (!cfg.apiKey || !address.trim()) return null;
  const { width = 600, height = 240, scale = 2 } = opts;
  const params = new URLSearchParams({
    center: address,
    zoom: String(cfg.mapPreview.zoom),
    size: `${width}x${height}`,
    scale: String(scale),
    maptype: cfg.mapPreview.mapType,
    markers: `color:red|${address}`,
    key: cfg.apiKey,
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}
