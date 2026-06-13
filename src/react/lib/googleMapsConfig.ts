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
  | 'contactEdit';

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

/**
 * Inject the Google Maps JS API (`places` library) once. Resolves when
 * `google.maps.places` is available; rejects on load error or timeout so
 * callers can degrade gracefully.
 */
export function loadPlacesScript(apiKey: string, language = 'en-GB'): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  const w = window as unknown as { google?: { maps?: { places?: unknown } } };
  if (w.google?.maps?.places) return Promise.resolve();
  if (_scriptPromise) return _scriptPromise;

  _scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById('google-maps-places-js');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Places JS failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.id = 'google-maps-places-js';
    script.async = true;
    script.defer = true;
    const params = new URLSearchParams({
      key: apiKey,
      libraries: 'places',
      language,
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    const timeout = window.setTimeout(() => {
      reject(new Error('Places JS load timed out'));
    }, 12000);
    script.onload = () => {
      window.clearTimeout(timeout);
      if (w.google?.maps?.places) resolve();
      else reject(new Error('Places library unavailable after load'));
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      _scriptPromise = null;
      reject(new Error('Places JS failed to load'));
    };
    document.head.appendChild(script);
  });
  return _scriptPromise;
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
