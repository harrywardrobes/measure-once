import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isViewUrlStale,
  resignResumedImages,
  visitIdFromHash,
  fetchFreshUrlsForDetail,
} from './DesignVisitsList';
import type { ExistingVisit } from '../../components/DesignVisitWizard';
import type { DesignVisit } from './types';

// ── Constants ──────────────────────────────────────────────────────────────────

const NOW_SEC    = 1_700_000_000;
const BUFFER_SEC = 5 * 60; // 5-minute freshness buffer used in the code
const VISIT_ID   = 42;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeVisit(overrides: Partial<ExistingVisit> = {}): ExistingVisit {
  return { id: VISIT_ID, rooms: [], ...overrides };
}

function makeImage(storageKey: string, viewUrl?: string) {
  return { storageKey, viewUrl };
}

function signedUrl(expOffset: number): string {
  return `/api/design-visits/${VISIT_ID}/photos/view?exp=${NOW_SEC + expOffset}&sig=test`;
}

// ── isViewUrlStale ─────────────────────────────────────────────────────────────

describe('isViewUrlStale', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when viewUrl is undefined (absent URL)', () => {
    expect(isViewUrlStale(undefined)).toBe(true);
  });

  it('returns true when viewUrl is an empty string', () => {
    expect(isViewUrlStale('')).toBe(true);
  });

  it('returns false for a fresh signed URL (exp well above now + 5 min)', () => {
    const url = signedUrl(BUFFER_SEC + 600); // expires 10+ min from now
    expect(isViewUrlStale(url)).toBe(false);
  });

  it('returns false for a URL expiring just above the 5-min buffer', () => {
    const url = signedUrl(BUFFER_SEC + 1); // exp = now + 5m + 1s — just fresh
    expect(isViewUrlStale(url)).toBe(false);
  });

  it('returns false for a URL expiring exactly at the 5-min buffer boundary (exp === now + 300, not strictly less)', () => {
    // isViewUrlStale uses `exp < floor(now/1000) + BUFFER_SEC` — equal is not stale
    const url = signedUrl(BUFFER_SEC); // exp === now + 300 → condition is false → fresh
    expect(isViewUrlStale(url)).toBe(false);
  });

  it('returns true for a URL expiring one second inside the 5-min buffer', () => {
    const url = signedUrl(BUFFER_SEC - 1); // exp < now + 300 → stale
    expect(isViewUrlStale(url)).toBe(true);
  });

  it('returns true for a URL that has already expired', () => {
    const url = signedUrl(-60); // expired 60 s ago
    expect(isViewUrlStale(url)).toBe(true);
  });

  it('returns false for a data: URI — no exp param, never a signed URL', () => {
    const dataUri = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    expect(isViewUrlStale(dataUri)).toBe(false);
  });

  it('returns false for a plain path with no query string', () => {
    expect(isViewUrlStale('/uploads/photo.jpg')).toBe(false);
  });

  it('handles an exp param in the middle of the query string', () => {
    const url = `/api/photo.jpg?foo=bar&exp=${NOW_SEC + BUFFER_SEC + 1}&sig=x`;
    expect(isViewUrlStale(url)).toBe(false);
  });
});

// ── resignResumedImages ────────────────────────────────────────────────────────

describe('resignResumedImages — short-circuit: no opaque keys needing resign', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns visit unchanged and issues no fetch when rooms is empty', async () => {
    const visit = makeVisit({ rooms: [] });
    const result = await resignResumedImages(visit);
    expect(result).toBe(visit);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns visit unchanged and issues no fetch when no room has images', async () => {
    const visit = makeVisit({ rooms: [{ room_name: 'Kitchen', images: [] }] });
    const result = await resignResumedImages(visit);
    expect(result).toBe(visit);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips resign when the only obj: image already has a fresh viewUrl', async () => {
    const visit = makeVisit({
      rooms: [{
        room_name: 'Bedroom',
        images: [makeImage('obj:bucket/photo.jpg', signedUrl(BUFFER_SEC + 600))],
      }],
    });
    const result = await resignResumedImages(visit);
    expect(result).toBe(visit);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips resign for a data: URI storageKey (offline-captured photo)', async () => {
    const visit = makeVisit({
      rooms: [{
        room_name: 'Hall',
        images: [makeImage('data:image/jpeg;base64,abc', undefined)],
      }],
    });
    const result = await resignResumedImages(visit);
    expect(result).toBe(visit);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips resign for images without a storageKey at all', async () => {
    const visit = makeVisit({
      rooms: [{ room_name: 'Lounge', images: [{ viewUrl: undefined }] }],
    });
    const result = await resignResumedImages(visit);
    expect(result).toBe(visit);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('resignResumedImages — stale keys trigger the bulk resign endpoint', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the resign endpoint for a visit with a stale obj: image', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ urls: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const visit = makeVisit({
      rooms: [{
        room_name: 'Kitchen',
        images: [makeImage('obj:bucket/photo.jpg', signedUrl(BUFFER_SEC - 1))],
      }],
    });

    await resignResumedImages(visit);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/design-visits/${VISIT_ID}/photos/resign`,
      { method: 'POST' },
    );
  });

  it('calls the resign endpoint when the obj: image has no viewUrl at all', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ urls: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const visit = makeVisit({
      rooms: [{
        room_name: 'Kitchen',
        images: [makeImage('obj:bucket/photo.jpg', undefined)],
      }],
    });

    await resignResumedImages(visit);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('maps returned URLs onto the correct images', async () => {
    const freshUrl = signedUrl(3600);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ urls: { 'obj:bucket/photo.jpg': freshUrl } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const visit = makeVisit({
      rooms: [{
        room_name: 'Kitchen',
        images: [makeImage('obj:bucket/photo.jpg', signedUrl(BUFFER_SEC - 1))],
      }],
    });

    const result = await resignResumedImages(visit);

    expect(result.rooms![0].images![0].viewUrl).toBe(freshUrl);
  });

  it('only updates images whose key is in the server response, leaves others intact', async () => {
    const freshUrl = signedUrl(3600);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ urls: { 'obj:bucket/stale.jpg': freshUrl } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const originalFreshUrl = signedUrl(BUFFER_SEC + 600);
    const visit = makeVisit({
      rooms: [{
        room_name: 'Kitchen',
        images: [
          makeImage('obj:bucket/fresh.jpg', originalFreshUrl),
          makeImage('obj:bucket/stale.jpg', signedUrl(BUFFER_SEC - 1)),
        ],
      }],
    });

    const result = await resignResumedImages(visit);

    expect(result.rooms![0].images![0].viewUrl).toBe(originalFreshUrl);
    expect(result.rooms![0].images![1].viewUrl).toBe(freshUrl);
  });

  it('maps URLs correctly across multiple rooms', async () => {
    const url1 = signedUrl(3600);
    const url2 = signedUrl(3601);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          urls: {
            'obj:bucket/a.jpg': url1,
            'obj:bucket/b.jpg': url2,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const visit = makeVisit({
      rooms: [
        { room_name: 'Room A', images: [makeImage('obj:bucket/a.jpg', undefined)] },
        { room_name: 'Room B', images: [makeImage('obj:bucket/b.jpg', undefined)] },
      ],
    });

    const result = await resignResumedImages(visit);

    expect(result.rooms![0].images![0].viewUrl).toBe(url1);
    expect(result.rooms![1].images![0].viewUrl).toBe(url2);
  });

  it('returns visit unchanged when the server response has an empty urls map', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ urls: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const staleUrl = signedUrl(BUFFER_SEC - 1);
    const visit = makeVisit({
      rooms: [{
        room_name: 'Kitchen',
        images: [makeImage('obj:bucket/photo.jpg', staleUrl)],
      }],
    });

    const result = await resignResumedImages(visit);

    expect(result).toBe(visit);
  });
});

describe('resignResumedImages — server error path', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns visit unchanged when fetch throws (network error / offline)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const visit = makeVisit({
      rooms: [{
        room_name: 'Kitchen',
        images: [makeImage('obj:bucket/photo.jpg', undefined)],
      }],
    });

    const result = await resignResumedImages(visit);

    expect(result).toBe(visit);
  });

  it('returns visit unchanged when the server responds with a non-ok status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    const visit = makeVisit({
      rooms: [{
        room_name: 'Kitchen',
        images: [makeImage('obj:bucket/photo.jpg', undefined)],
      }],
    });

    const result = await resignResumedImages(visit);

    expect(result).toBe(visit);
  });

  it('returns visit unchanged when the server responds with 401 (auth expired)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    const visit = makeVisit({
      rooms: [{
        room_name: 'Kitchen',
        images: [makeImage('obj:bucket/photo.jpg', undefined)],
      }],
    });

    const result = await resignResumedImages(visit);

    expect(result).toBe(visit);
  });
});

// ── visitIdFromHash ────────────────────────────────────────────────────────────

describe('visitIdFromHash', () => {
  it('returns the numeric id for a well-formed fragment', () => {
    expect(visitIdFromHash('#design-visit-42')).toBe(42);
  });

  it('returns the numeric id for a large id', () => {
    expect(visitIdFromHash('#design-visit-99999')).toBe(99999);
  });

  it('returns null for an empty string', () => {
    expect(visitIdFromHash('')).toBeNull();
  });

  it('returns null for an unrelated fragment', () => {
    expect(visitIdFromHash('#some-other-anchor')).toBeNull();
  });

  it('returns null when there is no leading hash', () => {
    expect(visitIdFromHash('design-visit-42')).toBeNull();
  });

  it('returns null when the fragment has a trailing suffix', () => {
    expect(visitIdFromHash('#design-visit-42-extra')).toBeNull();
  });
});

// ── fetchFreshUrlsForDetail — deep-link auto-resign path ──────────────────────

describe('fetchFreshUrlsForDetail — deep-link path: cached detail with stale photo URLs', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDetail(overrides: Partial<DesignVisit> = {}): DesignVisit {
    return { id: VISIT_ID, contact_id: 'c1', status: 'submitted', rooms: [], ...overrides };
  }

  it('returns null and issues no fetch when the detail has no rooms', async () => {
    const detail = makeDetail({ rooms: [] });
    const result = await fetchFreshUrlsForDetail(VISIT_ID, detail);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null and issues no fetch when all obj: images have fresh URLs', async () => {
    const detail = makeDetail({
      rooms: [{
        room_name: 'Kitchen',
        images: [{ storageKey: 'obj:bucket/photo.jpg', viewUrl: signedUrl(BUFFER_SEC + 600) }],
      }],
    });
    const result = await fetchFreshUrlsForDetail(VISIT_ID, detail);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls the resign endpoint when a cached detail has a stale obj: image (deep-link resign path)', async () => {
    const freshUrl = signedUrl(3600);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ urls: { 'obj:bucket/photo.jpg': freshUrl } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const detail = makeDetail({
      rooms: [{
        room_name: 'Kitchen',
        images: [{ storageKey: 'obj:bucket/photo.jpg', viewUrl: signedUrl(BUFFER_SEC - 1) }],
      }],
    });

    const result = await fetchFreshUrlsForDetail(VISIT_ID, detail);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/design-visits/${VISIT_ID}/photos/resign`,
      { method: 'POST' },
    );
    expect(result).toEqual({ 'obj:bucket/photo.jpg': freshUrl });
  });

  it('calls the resign endpoint when the obj: image has no viewUrl at all', async () => {
    const freshUrl = signedUrl(3600);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ urls: { 'obj:bucket/photo.jpg': freshUrl } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const detail = makeDetail({
      rooms: [{
        room_name: 'Kitchen',
        images: [{ storageKey: 'obj:bucket/photo.jpg' }],
      }],
    });

    const result = await fetchFreshUrlsForDetail(VISIT_ID, detail);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result).toEqual({ 'obj:bucket/photo.jpg': freshUrl });
  });

  it('returns a URL map covering all stale keys across multiple rooms', async () => {
    const url1 = signedUrl(3600);
    const url2 = signedUrl(3601);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ urls: { 'obj:bucket/a.jpg': url1, 'obj:bucket/b.jpg': url2 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const detail = makeDetail({
      rooms: [
        { room_name: 'Room A', images: [{ storageKey: 'obj:bucket/a.jpg' }] },
        { room_name: 'Room B', images: [{ storageKey: 'obj:bucket/b.jpg' }] },
      ],
    });

    const result = await fetchFreshUrlsForDetail(VISIT_ID, detail);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result).toEqual({ 'obj:bucket/a.jpg': url1, 'obj:bucket/b.jpg': url2 });
  });

  it('returns null when the server response has an empty urls map', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ urls: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const detail = makeDetail({
      rooms: [{
        room_name: 'Kitchen',
        images: [{ storageKey: 'obj:bucket/photo.jpg', viewUrl: signedUrl(BUFFER_SEC - 1) }],
      }],
    });

    const result = await fetchFreshUrlsForDetail(VISIT_ID, detail);
    expect(result).toBeNull();
  });

  it('returns null when the server responds with a non-ok status', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const detail = makeDetail({
      rooms: [{
        room_name: 'Kitchen',
        images: [{ storageKey: 'obj:bucket/photo.jpg', viewUrl: undefined }],
      }],
    });

    const result = await fetchFreshUrlsForDetail(VISIT_ID, detail);
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error / offline)', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const detail = makeDetail({
      rooms: [{
        room_name: 'Kitchen',
        images: [{ storageKey: 'obj:bucket/photo.jpg', viewUrl: undefined }],
      }],
    });

    const result = await fetchFreshUrlsForDetail(VISIT_ID, detail);
    expect(result).toBeNull();
  });
});
