/**
 * usePaginatedContacts — priority sort mode tests
 *
 * Covers filterSortPaginateCachedContacts() with both prioritySortMode values:
 *   - 'last_contacted': sort by notes_last_contacted ascending (nulls first),
 *     tie-break by createdate descending.
 *   - 'newest': legacy pin-no-status-then-newest behaviour.
 */

import { describe, it, expect } from 'vitest';
import { filterSortPaginateCachedContacts, type PaginatedContact } from '../usePaginatedContacts';

function makeContact(id: string, opts: {
  notes_last_contacted?: string | null;
  createdate?: string;
  hs_lead_status?: string;
} = {}): PaginatedContact {
  return {
    id,
    properties: {
      firstname: 'Test',
      lastname: `Contact${id}`,
      hs_lead_status: opts.hs_lead_status ?? 'OPEN_DEAL',
      createdate: opts.createdate ?? `2024-0${id}-01T00:00:00.000Z`,
      notes_last_contacted: opts.notes_last_contacted ?? undefined,
    },
  };
}

const baseParams = {
  leadStatus: '',
  stage: '',
  sortBy: 'priority',
  search: '',
  showArchived: false,
  priorityFirst: true,
  page: 1,
  limit: 25,
};

describe('filterSortPaginateCachedContacts — prioritySortMode: last_contacted', () => {
  it('places never-contacted contacts first', () => {
    const contacts = [
      makeContact('1', { notes_last_contacted: '2024-03-01T00:00:00.000Z' }),
      makeContact('2', { notes_last_contacted: null }),
      makeContact('3', { notes_last_contacted: '2024-01-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...baseParams,
      prioritySortMode: 'last_contacted',
    });
    expect(results[0].id).toBe('2');
  });

  it('sorts remaining contacts ascending by notes_last_contacted (oldest first)', () => {
    const contacts = [
      makeContact('1', { notes_last_contacted: '2024-06-01T00:00:00.000Z' }),
      makeContact('2', { notes_last_contacted: '2024-01-01T00:00:00.000Z' }),
      makeContact('3', { notes_last_contacted: '2024-03-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...baseParams,
      prioritySortMode: 'last_contacted',
    });
    expect(results.map(r => r.id)).toEqual(['2', '3', '1']);
  });

  it('tie-breaks by createdate descending when notes_last_contacted are equal', () => {
    const ts = '2024-03-01T00:00:00.000Z';
    const contacts = [
      makeContact('A', { notes_last_contacted: ts, createdate: '2024-01-01T00:00:00.000Z' }),
      makeContact('B', { notes_last_contacted: ts, createdate: '2024-03-01T00:00:00.000Z' }),
      makeContact('C', { notes_last_contacted: ts, createdate: '2024-02-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...baseParams,
      prioritySortMode: 'last_contacted',
    });
    expect(results.map(r => r.id)).toEqual(['B', 'C', 'A']);
  });

  it('tie-breaks by createdate descending for multiple never-contacted contacts', () => {
    const contacts = [
      makeContact('old', { notes_last_contacted: null, createdate: '2024-01-01T00:00:00.000Z' }),
      makeContact('new', { notes_last_contacted: null, createdate: '2024-06-01T00:00:00.000Z' }),
      makeContact('mid', { notes_last_contacted: null, createdate: '2024-03-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...baseParams,
      prioritySortMode: 'last_contacted',
    });
    expect(results.map(r => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('does not apply last_contacted sort when a leadStatus filter is active', () => {
    // When leadStatus is set, priorityFirst is suppressed and the base
    // comparator (offlineComparator('priority') = newest-created-first) applies.
    // Contact '2' has a newer createdate ('2024-02-01') than '1' ('2024-01-01'),
    // so it should sort first regardless of notes_last_contacted.
    const contacts = [
      makeContact('1', { hs_lead_status: 'OPEN_DEAL', notes_last_contacted: '2024-06-01T00:00:00.000Z', createdate: '2024-01-01T00:00:00.000Z' }),
      makeContact('2', { hs_lead_status: 'OPEN_DEAL', notes_last_contacted: '2024-01-01T00:00:00.000Z', createdate: '2024-02-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...baseParams,
      leadStatus: 'OPEN_DEAL',
      prioritySortMode: 'last_contacted',
    });
    // priorityFirst && !leadStatus is false → falls back to newest-created-first
    // '2' (2024-02-01) is newer than '1' (2024-01-01)
    expect(results.map(r => r.id)).toEqual(['2', '1']);
  });
});

describe('filterSortPaginateCachedContacts — prioritySortMode: newest', () => {
  it('pins no-status contacts to the top', () => {
    const contacts = [
      makeContact('1', { hs_lead_status: 'OPEN_DEAL', createdate: '2024-06-01T00:00:00.000Z' }),
      makeContact('2', { hs_lead_status: '',           createdate: '2024-01-01T00:00:00.000Z' }),
      makeContact('3', { hs_lead_status: 'OPEN_DEAL', createdate: '2024-03-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...baseParams,
      prioritySortMode: 'newest',
    });
    expect(results[0].id).toBe('2');
    expect(results.map(r => r.id)).toEqual(['2', '1', '3']);
  });

  it('sorts statused contacts by createdate descending after pinned rows', () => {
    const contacts = [
      makeContact('old', { hs_lead_status: 'A', createdate: '2024-01-01T00:00:00.000Z' }),
      makeContact('new', { hs_lead_status: 'A', createdate: '2024-06-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...baseParams,
      prioritySortMode: 'newest',
    });
    expect(results.map(r => r.id)).toEqual(['new', 'old']);
  });
});

describe('filterSortPaginateCachedContacts — prioritySortMode defaults', () => {
  it('defaults to last_contacted behaviour when prioritySortMode is absent', () => {
    const contacts = [
      makeContact('1', { notes_last_contacted: '2024-06-01T00:00:00.000Z' }),
      makeContact('2', { notes_last_contacted: null }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, {
      ...baseParams,
    });
    expect(results[0].id).toBe('2');
  });
});
