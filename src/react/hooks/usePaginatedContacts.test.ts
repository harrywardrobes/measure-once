import { describe, it, expect, vi } from 'vitest';
import { filterSortPaginateCachedContacts } from './usePaginatedContacts';
import type { PaginatedContact } from './usePaginatedContacts';

vi.mock('../lib/offlineDb', () => ({
  cacheRecord: vi.fn(),
  cacheRecords: vi.fn(),
  readRecord: vi.fn(),
  readRecords: vi.fn(),
  getMeta: vi.fn(),
  setMeta: vi.fn(),
}));

vi.mock('../constants/localStorageKeys', () => ({
  CONTACTS_LAST_SYNC_META_KEY: 'contacts_last_sync',
}));

function makeContact(id: string, hs_lead_status?: string): PaginatedContact {
  return { id, properties: { hs_lead_status } };
}

const BASE_PARAMS = {
  leadStatus: '',
  stage: '',
  sortBy: 'newest',
  search: '',
  showArchived: false,
  page: 1,
  limit: 50,
  priorityFirst: false,
};

describe('filterSortPaginateCachedContacts — showExcluded', () => {
  const excludedStatusKeys = new Set(['UNQUALIFIED']);
  const contacts: PaginatedContact[] = [
    makeContact('1', 'NEW'),
    makeContact('2', 'UNQUALIFIED'),
    makeContact('3', 'OPEN'),
  ];

  it('hides contacts with an excluded hs_lead_status when showExcluded is false', () => {
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...BASE_PARAMS,
      showExcluded: false,
      excludedStatusKeys,
    });
    const ids = results.map((c) => c.id);
    expect(ids).not.toContain('2');
    expect(ids).toContain('1');
    expect(ids).toContain('3');
  });

  it('includes contacts with an excluded hs_lead_status when showExcluded is true', () => {
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...BASE_PARAMS,
      showExcluded: true,
      excludedStatusKeys,
    });
    const ids = results.map((c) => c.id);
    expect(ids).toContain('2');
    expect(ids).toContain('1');
    expect(ids).toContain('3');
  });

  it('includes excluded contacts when the caller is explicitly filtering by that excluded status', () => {
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...BASE_PARAMS,
      showExcluded: false,
      leadStatus: 'UNQUALIFIED',
      excludedStatusKeys,
    });
    const ids = results.map((c) => c.id);
    expect(ids).toContain('2');
    expect(ids).not.toContain('1');
    expect(ids).not.toContain('3');
  });
});
