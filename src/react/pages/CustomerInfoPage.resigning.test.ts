import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildRestoredPhotos,
  resignSavedPhotosAfterRestore,
  type UploadedPhoto,
} from './CustomerInfoPage';
import { CUSTOMER_INFO_DRAFT_PREFIX } from '../constants/localStorageKeys';

// ── Constants ──────────────────────────────────────────────────────────────────

const PREVIEW_BASE = '/api/customer-info-preview/abc/photo.jpg';
const NOW_SEC      = 1_700_000_000; // fixed epoch for deterministic tests
const BUFFER_SEC   = 300;           // 5-minute freshness buffer used in the code

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshUrl(expiresInSec: number): string {
  return `${PREVIEW_BASE}?exp=${NOW_SEC + expiresInSec}&sig=test`;
}

function makePhoto(overrides: Partial<UploadedPhoto> = {}): UploadedPhoto {
  return {
    key:        'photos/test.jpg',
    previewUrl: '',
    name:       'test.jpg',
    ...overrides,
  };
}

// ── buildRestoredPhotos ───────────────────────────────────────────────────────

describe('buildRestoredPhotos', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets previewUrl when the stored URL is fresh (exp > now + 5 min)', () => {
    const url = freshUrl(BUFFER_SEC + 1); // just above the buffer
    const [photo] = buildRestoredPhotos(['photos/a.jpg'], ['a.jpg'], [url], [NOW_SEC + BUFFER_SEC + 1]);
    expect(photo.previewUrl).toBe(url);
  });

  it('clears previewUrl when the expiry is exactly at the boundary (exp === now + 5 min)', () => {
    const url = `${PREVIEW_BASE}?exp=${NOW_SEC + BUFFER_SEC}&sig=test`;
    const [photo] = buildRestoredPhotos(
      ['photos/a.jpg'],
      ['a.jpg'],
      [url],
      [NOW_SEC + BUFFER_SEC],
    );
    // exp > nowSec + 300 is false when equal → treated as stale
    expect(photo.previewUrl).toBe('');
  });

  it('clears previewUrl when the expiry is just below the 5-min buffer', () => {
    const url = `${PREVIEW_BASE}?exp=${NOW_SEC + BUFFER_SEC - 1}&sig=test`;
    const [photo] = buildRestoredPhotos(
      ['photos/a.jpg'],
      ['a.jpg'],
      [url],
      [NOW_SEC + BUFFER_SEC - 1],
    );
    expect(photo.previewUrl).toBe('');
  });

  it('clears previewUrl for a non-preview URL even if expiry would be fine', () => {
    const url = 'https://external.example.com/photo.jpg';
    const [photo] = buildRestoredPhotos(
      ['photos/a.jpg'],
      ['a.jpg'],
      [url],
      [NOW_SEC + 9999],
    );
    expect(photo.previewUrl).toBe('');
  });

  it('clears previewUrl when no stored URL is provided', () => {
    const [photo] = buildRestoredPhotos(['photos/a.jpg']);
    expect(photo.previewUrl).toBe('');
  });

  it('handles a mix: fresh photo keeps its URL, stale photo gets empty string', () => {
    const freshExp = NOW_SEC + BUFFER_SEC + 60;
    const staleExp = NOW_SEC + BUFFER_SEC - 60;
    const freshPhotoUrl = `${PREVIEW_BASE}?exp=${freshExp}&sig=x`;
    const stalePhotoUrl = `${PREVIEW_BASE}?exp=${staleExp}&sig=x`;

    const photos = buildRestoredPhotos(
      ['photos/fresh.jpg', 'photos/stale.jpg'],
      ['fresh.jpg', 'stale.jpg'],
      [freshPhotoUrl, stalePhotoUrl],
      [freshExp, staleExp],
    );

    expect(photos[0].previewUrl).toBe(freshPhotoUrl);
    expect(photos[1].previewUrl).toBe('');
  });

  it('infers isPdf from the key extension', () => {
    const [pdf, img] = buildRestoredPhotos(['docs/file.pdf', 'photos/img.jpg']);
    expect(pdf.isPdf).toBe(true);
    expect(img.isPdf).toBe(false);
  });

  it('backward-compat: uses URL exp param when savedPhotoExpiries is absent', () => {
    const freshExp = NOW_SEC + BUFFER_SEC + 60;
    const url = `${PREVIEW_BASE}?exp=${freshExp}&sig=legacy`;
    // No expiries array — simulates a draft written before savedPhotoExpiries was introduced
    const [photo] = buildRestoredPhotos(['photos/a.jpg'], ['a.jpg'], [url]);
    expect(photo.previewUrl).toBe(url);
  });
});

// ── resignSavedPhotosAfterRestore ─────────────────────────────────────────────

describe('resignSavedPhotosAfterRestore — fast-path: no fetch when all photos are fresh', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues no fetch call when every photo already has a previewUrl', async () => {
    const photos: UploadedPhoto[] = [
      makePhoto({ previewUrl: '/api/customer-info-preview/abc/a.jpg?exp=999&sig=x' }),
      makePhoto({ key: 'photos/b.jpg', previewUrl: '/api/customer-info-preview/abc/b.jpg?exp=999&sig=x', name: 'b.jpg' }),
    ];

    const setPhotos = vi.fn();
    await resignSavedPhotosAfterRestore('tok', photos, setPhotos);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setPhotos).not.toHaveBeenCalled();
  });

  it('issues no fetch call when the photo list is empty', async () => {
    const setPhotos = vi.fn();
    await resignSavedPhotosAfterRestore('tok', [], setPhotos);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setPhotos).not.toHaveBeenCalled();
  });

  it('does NOT skip fetch when at least one photo has an empty previewUrl', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ key: 'photos/stale.jpg', url: '/api/customer-info-preview/abc/stale.jpg?exp=999&sig=new' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const photos: UploadedPhoto[] = [
      makePhoto({ previewUrl: '/api/customer-info-preview/abc/fresh.jpg?exp=999&sig=x' }),
      makePhoto({ key: 'photos/stale.jpg', previewUrl: '', name: 'stale.jpg' }),
    ];

    const setPhotos = vi.fn((_updater: (prev: UploadedPhoto[]) => UploadedPhoto[]) => {});
    await resignSavedPhotosAfterRestore('tok', photos, setPhotos);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/customer-info/tok/sign'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('only sends stale keys in the sign request body', async () => {
    let capturedBody: unknown;
    fetchSpy.mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const photos: UploadedPhoto[] = [
      makePhoto({ key: 'photos/fresh.jpg', previewUrl: '/signed/fresh.jpg', name: 'fresh.jpg' }),
      makePhoto({ key: 'photos/stale.jpg', previewUrl: '', name: 'stale.jpg' }),
    ];

    await resignSavedPhotosAfterRestore('tok', photos, vi.fn());

    expect(capturedBody).toEqual({ keys: ['photos/stale.jpg'] });
  });

  it('calls onResigned with the updated photo array after a successful sign', async () => {
    const newUrl = '/api/customer-info-preview/abc/stale.jpg?exp=999&sig=new';
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [{ key: 'photos/stale.jpg', url: newUrl }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const photos: UploadedPhoto[] = [
      makePhoto({ key: 'photos/stale.jpg', previewUrl: '', name: 'stale.jpg' }),
    ];

    const setPhotos = vi.fn((updater: (prev: UploadedPhoto[]) => UploadedPhoto[]) => updater(photos));
    const onResigned = vi.fn();

    await resignSavedPhotosAfterRestore('tok', photos, setPhotos, onResigned);

    expect(onResigned).toHaveBeenCalledOnce();
    const [resigned] = onResigned.mock.calls[0] as [UploadedPhoto[]];
    expect(resigned[0].previewUrl).toBe(newUrl);
  });

  it('does not call onResigned when the fast-path exits early (all fresh)', async () => {
    const photos: UploadedPhoto[] = [
      makePhoto({ previewUrl: '/api/customer-info-preview/abc/a.jpg?exp=999&sig=x' }),
    ];

    const onResigned = vi.fn();
    await resignSavedPhotosAfterRestore('tok', photos, vi.fn(), onResigned);

    expect(onResigned).not.toHaveBeenCalled();
  });
});

// ── Boundary: buildRestoredPhotos feeds resignSavedPhotosAfterRestore ─────────

describe('buildRestoredPhotos → resignSavedPhotosAfterRestore boundary integration', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the sign request when buildRestoredPhotos marks all photos as fresh', async () => {
    const freshExp = NOW_SEC + BUFFER_SEC + 1;
    const url      = `${PREVIEW_BASE}?exp=${freshExp}&sig=ok`;

    const photos = buildRestoredPhotos(
      ['photos/a.jpg'],
      ['a.jpg'],
      [url],
      [freshExp],
    );

    // Every photo has a non-empty previewUrl → fast path should engage
    expect(photos.every(p => p.previewUrl !== '')).toBe(true);

    await resignSavedPhotosAfterRestore('tok', photos, vi.fn());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('triggers a sign request when buildRestoredPhotos marks a photo as stale (exp at boundary)', async () => {
    const boundaryExp = NOW_SEC + BUFFER_SEC; // not strictly greater → stale
    const url         = `${PREVIEW_BASE}?exp=${boundaryExp}&sig=old`;

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ key: 'photos/a.jpg', url: null }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const photos = buildRestoredPhotos(
      ['photos/a.jpg'],
      ['a.jpg'],
      [url],
      [boundaryExp],
    );

    expect(photos[0].previewUrl).toBe(''); // stale → empty string

    await resignSavedPhotosAfterRestore('tok', photos, vi.fn());
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

// ── Integration: restore → re-sign → draft-persist round-trip ─────────────────
//
// These tests exercise the full chain that the three call-sites in
// CustomerInfoPage follow:
//   1. buildRestoredPhotos  — turn draft arrays back into UploadedPhoto objects
//   2. resignSavedPhotosAfterRestore — fetch fresh signed URLs for stale photos
//   3. onResigned callback  — write the fresh photos back to localStorage
//
// The onResigned callback here mirrors exactly what the real saveDraft() call
// inside each call-site does (writes savedPhotoUrls / Keys / Names to
// localStorage under CUSTOMER_INFO_DRAFT_PREFIX + token).

describe('restore → re-sign → draft-persist integration', () => {
  const TOKEN = 'test-token-abc';
  const LS_KEY = CUSTOMER_INFO_DRAFT_PREFIX + TOKEN;
  const NOW_S  = 1_700_100_000;
  const BUF    = 300; // 5-min freshness buffer used by buildRestoredPhotos

  // Minimal saveDraft-style helper: merges fresh photo arrays into the stored draft.
  // Mirrors the real saveDraft() which also writes savedPhotoExpiries by parsing
  // the `exp` query-param from each signed preview URL.
  function persistFreshPhotos(freshPhotos: UploadedPhoto[]) {
    const existing: Record<string, unknown> = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    localStorage.setItem(LS_KEY, JSON.stringify({
      ...existing,
      savedPhotoKeys:     freshPhotos.map(p => p.key),
      savedPhotoNames:    freshPhotos.map(p => p.name),
      savedPhotoUrls:     freshPhotos.map(p => p.previewUrl),
      savedPhotoExpiries: freshPhotos.map(p => {
        if (!p.previewUrl.startsWith('/api/customer-info-preview/')) return 0;
        try {
          const qs  = p.previewUrl.split('?')[1] ?? '';
          const exp = parseInt(new URLSearchParams(qs).get('exp') ?? '', 10);
          return Number.isFinite(exp) ? exp : 0;
        } catch { return 0; }
      }),
    }));
  }

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_S * 1000);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('writes the fresh signed URL to localStorage after a stale photo is re-signed', async () => {
    const staleExp = NOW_S + BUF - 60;                                   // expired
    const staleUrl = `/api/customer-info-preview/abc/p.jpg?exp=${staleExp}&sig=old`;
    const freshUrl = `/api/customer-info-preview/abc/p.jpg?exp=${NOW_S + 3600}&sig=new`;

    // Seed localStorage with a draft whose photo URL is stale
    localStorage.setItem(LS_KEY, JSON.stringify({
      savedPhotoKeys:  ['photos/p.jpg'],
      savedPhotoNames: ['p.jpg'],
      savedPhotoUrls:  [staleUrl],
      savedPhotoExpiries: [staleExp],
    }));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [{ key: 'photos/p.jpg', url: freshUrl }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const restored = buildRestoredPhotos(
      ['photos/p.jpg'], ['p.jpg'], [staleUrl], [staleExp],
    );
    expect(restored[0].previewUrl).toBe(''); // stale → empty, confirms re-sign will run

    const setPhotos = vi.fn((updater: (prev: UploadedPhoto[]) => UploadedPhoto[]) => updater(restored));

    await resignSavedPhotosAfterRestore(TOKEN, restored, setPhotos, persistFreshPhotos);

    const saved = JSON.parse(localStorage.getItem(LS_KEY)!);
    expect(saved.savedPhotoUrls[0]).toBe(freshUrl);
  });

  it('updates only the stale photo URL while preserving the fresh photo URL in localStorage', async () => {
    const freshExp = NOW_S + BUF + 600;
    const staleExp = NOW_S + BUF - 60;
    const freshUrl  = `/api/customer-info-preview/abc/a.jpg?exp=${freshExp}&sig=keep`;
    const staleUrl  = `/api/customer-info-preview/abc/b.jpg?exp=${staleExp}&sig=old`;
    const resignedUrl = `/api/customer-info-preview/abc/b.jpg?exp=${NOW_S + 3600}&sig=new`;

    localStorage.setItem(LS_KEY, JSON.stringify({
      savedPhotoKeys:  ['photos/a.jpg', 'photos/b.jpg'],
      savedPhotoNames: ['a.jpg', 'b.jpg'],
      savedPhotoUrls:  [freshUrl, staleUrl],
      savedPhotoExpiries: [freshExp, staleExp],
    }));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [{ key: 'photos/b.jpg', url: resignedUrl }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const restored = buildRestoredPhotos(
      ['photos/a.jpg', 'photos/b.jpg'],
      ['a.jpg', 'b.jpg'],
      [freshUrl, staleUrl],
      [freshExp, staleExp],
    );
    expect(restored[0].previewUrl).toBe(freshUrl);  // fresh — kept
    expect(restored[1].previewUrl).toBe('');          // stale — cleared

    const setPhotos = vi.fn((updater: (prev: UploadedPhoto[]) => UploadedPhoto[]) => updater(restored));

    await resignSavedPhotosAfterRestore(TOKEN, restored, setPhotos, persistFreshPhotos);

    const saved = JSON.parse(localStorage.getItem(LS_KEY)!);
    expect(saved.savedPhotoUrls[0]).toBe(freshUrl);    // fresh photo unchanged
    expect(saved.savedPhotoUrls[1]).toBe(resignedUrl); // stale photo now has fresh URL
  });

  it('does NOT call onResigned and leaves localStorage unchanged when all photos are fresh', async () => {
    const freshExp = NOW_S + BUF + 600;
    const freshUrl = `/api/customer-info-preview/abc/a.jpg?exp=${freshExp}&sig=keep`;

    const originalPayload = {
      savedPhotoKeys:  ['photos/a.jpg'],
      savedPhotoNames: ['a.jpg'],
      savedPhotoUrls:  [freshUrl],
      savedPhotoExpiries: [freshExp],
    };
    localStorage.setItem(LS_KEY, JSON.stringify(originalPayload));

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onResigned = vi.fn();

    const restored = buildRestoredPhotos(
      ['photos/a.jpg'], ['a.jpg'], [freshUrl], [freshExp],
    );
    expect(restored[0].previewUrl).toBe(freshUrl); // still fresh

    await resignSavedPhotosAfterRestore(TOKEN, restored, vi.fn(), onResigned);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onResigned).not.toHaveBeenCalled();

    // localStorage is untouched
    const saved = JSON.parse(localStorage.getItem(LS_KEY)!);
    expect(saved.savedPhotoUrls[0]).toBe(freshUrl);
  });

  it('treats a re-signed photo as fresh on the next restore — no re-sign in cycle 2', async () => {
    const staleExp   = NOW_S + BUF - 60;             // expired relative to NOW_S
    const freshExpC1 = NOW_S + 3600;                 // expiry returned by the sign endpoint
    const staleUrl   = `/api/customer-info-preview/abc/p.jpg?exp=${staleExp}&sig=old`;
    const freshUrl   = `/api/customer-info-preview/abc/p.jpg?exp=${freshExpC1}&sig=new`;

    // Seed localStorage with a draft whose photo URL is stale
    localStorage.setItem(LS_KEY, JSON.stringify({
      savedPhotoKeys:     ['photos/p.jpg'],
      savedPhotoNames:    ['p.jpg'],
      savedPhotoUrls:     [staleUrl],
      savedPhotoExpiries: [staleExp],
    }));

    // ── Cycle 1: stale photo gets re-signed, draft persisted with fresh URL + expiry ──
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [{ key: 'photos/p.jpg', url: freshUrl }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const restoredC1 = buildRestoredPhotos(['photos/p.jpg'], ['p.jpg'], [staleUrl], [staleExp]);
    expect(restoredC1[0].previewUrl).toBe(''); // stale → cleared

    const setPhotosC1 = vi.fn((updater: (prev: UploadedPhoto[]) => UploadedPhoto[]) => updater(restoredC1));
    await resignSavedPhotosAfterRestore(TOKEN, restoredC1, setPhotosC1, persistFreshPhotos);

    expect(fetchSpy).toHaveBeenCalledOnce(); // sign was called in cycle 1

    // Draft now has the fresh URL AND its parsed expiry
    const savedAfterC1 = JSON.parse(localStorage.getItem(LS_KEY)!);
    expect(savedAfterC1.savedPhotoUrls[0]).toBe(freshUrl);
    expect(savedAfterC1.savedPhotoExpiries[0]).toBe(freshExpC1);

    // ── Cycle 2: restore from updated draft — photo is fresh, no re-sign needed ──
    fetchSpy.mockClear();

    const restoredC2 = buildRestoredPhotos(
      savedAfterC1.savedPhotoKeys,
      savedAfterC1.savedPhotoNames,
      savedAfterC1.savedPhotoUrls,
      savedAfterC1.savedPhotoExpiries,
    );
    expect(restoredC2[0].previewUrl).toBe(freshUrl); // fresh URL retained

    await resignSavedPhotosAfterRestore(TOKEN, restoredC2, vi.fn());
    expect(fetchSpy).not.toHaveBeenCalled(); // fast-path: no re-sign needed
  });

  it('writes savedPhotoExpiries correctly when there is no pre-existing draft (cold start)', async () => {
    const staleExp = NOW_S + BUF - 60;
    const staleUrl = `/api/customer-info-preview/abc/p.jpg?exp=${staleExp}&sig=old`;
    const newExp   = NOW_S + 3600;
    const newUrl   = `/api/customer-info-preview/abc/p.jpg?exp=${newExp}&sig=new`;

    // localStorage is empty — no pre-existing draft key at all
    expect(localStorage.getItem(LS_KEY)).toBeNull();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [{ key: 'photos/p.jpg', url: newUrl }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const restored = buildRestoredPhotos(
      ['photos/p.jpg'], ['p.jpg'], [staleUrl], [staleExp],
    );
    expect(restored[0].previewUrl).toBe(''); // stale → cleared, re-sign will run

    const setPhotos = vi.fn((updater: (prev: UploadedPhoto[]) => UploadedPhoto[]) => updater(restored));
    await resignSavedPhotosAfterRestore(TOKEN, restored, setPhotos, persistFreshPhotos);

    const saved = JSON.parse(localStorage.getItem(LS_KEY)!);
    expect(saved.savedPhotoUrls[0]).toBe(newUrl);
    expect(saved.savedPhotoExpiries[0]).toBe(newExp);
    expect(saved.savedPhotoKeys[0]).toBe('photos/p.jpg');
    expect(saved.savedPhotoNames[0]).toBe('p.jpg');
  });

  it('preserves non-photo draft fields (e.g. genericFields) when persisting re-signed photos', async () => {
    const staleExp  = NOW_S + BUF - 60;
    const staleUrl  = `/api/customer-info-preview/abc/p.jpg?exp=${staleExp}&sig=old`;
    const freshUrl  = `/api/customer-info-preview/abc/p.jpg?exp=${NOW_S + 3600}&sig=new`;

    const originalDraft = {
      roomNotes: 'master bedroom',
      savedPhotoKeys:  ['photos/p.jpg'],
      savedPhotoNames: ['p.jpg'],
      savedPhotoUrls:  [staleUrl],
      savedPhotoExpiries: [staleExp],
      genericFields: { email: 'user@example.com', phone: '555-1234' },
    };
    localStorage.setItem(LS_KEY, JSON.stringify(originalDraft));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ results: [{ key: 'photos/p.jpg', url: freshUrl }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const restored = buildRestoredPhotos(
      ['photos/p.jpg'], ['p.jpg'], [staleUrl], [staleExp],
    );

    const setPhotos = vi.fn((updater: (prev: UploadedPhoto[]) => UploadedPhoto[]) => updater(restored));

    await resignSavedPhotosAfterRestore(TOKEN, restored, setPhotos, persistFreshPhotos);

    const saved = JSON.parse(localStorage.getItem(LS_KEY)!);
    // Fresh URL persisted
    expect(saved.savedPhotoUrls[0]).toBe(freshUrl);
    // Non-photo fields left intact by the merge in persistFreshPhotos
    expect(saved.roomNotes).toBe('master bedroom');
    expect(saved.genericFields).toEqual({ email: 'user@example.com', phone: '555-1234' });
  });
});
