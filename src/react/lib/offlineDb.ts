/**
 * IndexedDB store for offline read caching (Phase 1) and the foundation for the
 * Phase 2 write queue.
 *
 * The Workbox service worker (public/sw.js) transparently caches raw HTTP
 * responses, which is what makes the app render cached data offline. This
 * IndexedDB layer is a parallel, *structured* cache: pages write fetched
 * customer / visit / photo records through here so Phase 2 can build a write
 * queue and conflict detection on top of a known-good local data model.
 *
 * Design notes:
 *  - Stores: `customers`, `visits`, `photos` (cached read data), `meta`
 *    (freshness bookkeeping), and `outbox` (RESERVED for the Phase 2 write
 *    queue — created now so adding it later isn't a schema migration).
 *  - Every cached record is wrapped with a `cachedAt` timestamp and indexed by
 *    it, so eviction (oldest-first) and TTL pruning are cheap.
 *  - All operations are defensive: if IndexedDB is unavailable (SSR, private
 *    mode, quota errors) they no-op rather than throw, so callers can use them
 *    as fire-and-forget write-through without risking the UI.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const OFFLINE_DB_NAME = 'measure-once-offline';
export const OFFLINE_DB_VERSION = 1;

/** Cached-data stores (excludes `meta` and the reserved `outbox`). */
export type CacheStore = 'customers' | 'visits' | 'photos';

/** Bounded freshness/eviction policy. See docs/OFFLINE.md. */
export const CACHE_LIMITS: Record<CacheStore, number> = {
  customers: 200,
  visits: 250,
  photos: 150,
};

/** Records older than this are pruned on next write (12 hours). */
export const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface CachedRecord<T = unknown> {
  id: string;
  data: T;
  cachedAt: number;
}

interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

/** Reserved for the Phase 2 write queue — intentionally loose. */
interface OutboxRecord {
  id?: number;
  [key: string]: unknown;
}

interface OfflineDB extends DBSchema {
  customers: { key: string; value: CachedRecord; indexes: { cachedAt: number } };
  visits: { key: string; value: CachedRecord; indexes: { cachedAt: number } };
  photos: { key: string; value: CachedRecord; indexes: { cachedAt: number } };
  meta: { key: string; value: MetaRecord };
  outbox: { key: number; value: OutboxRecord };
}

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

let _dbPromise: Promise<IDBPDatabase<OfflineDB>> | null = null;

function getDb(): Promise<IDBPDatabase<OfflineDB>> | null {
  if (!idbAvailable()) return null;
  if (!_dbPromise) {
    _dbPromise = openDB<OfflineDB>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
      upgrade(db) {
        for (const name of ['customers', 'visits', 'photos'] as const) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: 'id' });
            store.createIndex('cachedAt', 'cachedAt');
          }
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        // Reserved for Phase 2 write queue.
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
        }
      },
    }).catch((err) => {
      // Reset so a later call can retry; surface nothing to the UI.
      _dbPromise = null;
      throw err;
    });
  }
  return _dbPromise;
}

/**
 * Write-through cache a batch of records into a store. Each item must have a
 * stable identifier (defaults to its `id` field). Fire-and-forget safe: never
 * rejects — failures are swallowed so callers can ignore the returned promise.
 */
export async function cacheRecords<T>(
  store: CacheStore,
  items: T[],
  getId: (item: T) => string | number | undefined = (item) =>
    (item as { id?: string | number }).id,
): Promise<void> {
  const dbp = getDb();
  if (!dbp || !Array.isArray(items) || items.length === 0) return;
  try {
    const db = await dbp;
    const now = Date.now();
    const tx = db.transaction(store, 'readwrite');
    for (const item of items) {
      const rawId = getId(item);
      if (rawId === undefined || rawId === null) continue;
      await tx.store.put({ id: String(rawId), data: item, cachedAt: now });
    }
    await tx.done;
    await enforceLimit(store);
  } catch {
    /* offline cache is best-effort */
  }
}

/** Write-through cache a single record. */
export async function cacheRecord<T>(store: CacheStore, id: string | number, data: T): Promise<void> {
  const dbp = getDb();
  if (!dbp || id === undefined || id === null) return;
  try {
    const db = await dbp;
    await db.put(store, { id: String(id), data: data as unknown, cachedAt: Date.now() });
    await enforceLimit(store);
  } catch {
    /* best-effort */
  }
}

/** Read all non-expired records from a store (newest first). */
export async function readRecords<T>(store: CacheStore): Promise<T[]> {
  const dbp = getDb();
  if (!dbp) return [];
  try {
    const db = await dbp;
    const all = await db.getAll(store);
    const cutoff = Date.now() - CACHE_MAX_AGE_MS;
    return all
      .filter((r) => r.cachedAt >= cutoff)
      .sort((a, b) => b.cachedAt - a.cachedAt)
      .map((r) => r.data as T);
  } catch {
    return [];
  }
}

/** Read a single non-expired record by id, or null. */
export async function readRecord<T>(store: CacheStore, id: string | number): Promise<T | null> {
  const dbp = getDb();
  if (!dbp || id === undefined || id === null) return null;
  try {
    const db = await dbp;
    const rec = await db.get(store, String(id));
    if (!rec) return null;
    if (rec.cachedAt < Date.now() - CACHE_MAX_AGE_MS) return null;
    return rec.data as T;
  } catch {
    return null;
  }
}

/** Store a small freshness/bookkeeping value. */
export async function setMeta(key: string, value: unknown): Promise<void> {
  const dbp = getDb();
  if (!dbp) return;
  try {
    const db = await dbp;
    await db.put('meta', { key, value, updatedAt: Date.now() });
  } catch {
    /* best-effort */
  }
}

/** Read a freshness/bookkeeping value, or null. */
export async function getMeta<T>(key: string): Promise<T | null> {
  const dbp = getDb();
  if (!dbp) return null;
  try {
    const db = await dbp;
    const rec = await db.get('meta', key);
    return rec ? (rec.value as T) : null;
  } catch {
    return null;
  }
}

/** Evict oldest records past the store limit and prune expired entries. */
async function enforceLimit(store: CacheStore): Promise<void> {
  const dbp = getDb();
  if (!dbp) return;
  try {
    const db = await dbp;
    const limit = CACHE_LIMITS[store];
    const cutoff = Date.now() - CACHE_MAX_AGE_MS;
    const tx = db.transaction(store, 'readwrite');
    const index = tx.store.index('cachedAt');
    // Walk oldest → newest. Delete expired entries; count survivors.
    const keep: IDBValidKey[] = [];
    let cursor = await index.openCursor();
    while (cursor) {
      if (cursor.value.cachedAt < cutoff) {
        await cursor.delete();
      } else {
        keep.push(cursor.primaryKey);
      }
      cursor = await cursor.continue();
    }
    // `keep` is oldest-first; trim the front if we're over the limit.
    const overflow = keep.length - limit;
    for (let i = 0; i < overflow; i++) {
      await tx.store.delete(keep[i] as string);
    }
    await tx.done;
  } catch {
    /* best-effort */
  }
}

/**
 * Clear all offline data. Call on logout so cached customer/finance data does
 * not persist for the next person using the same browser profile.
 */
export async function clearOfflineDb(): Promise<void> {
  const dbp = getDb();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(['customers', 'visits', 'photos', 'meta', 'outbox'], 'readwrite');
    await Promise.all([
      tx.objectStore('customers').clear(),
      tx.objectStore('visits').clear(),
      tx.objectStore('photos').clear(),
      tx.objectStore('meta').clear(),
      tx.objectStore('outbox').clear(),
    ]);
    await tx.done;
  } catch {
    /* best-effort */
  }
}
