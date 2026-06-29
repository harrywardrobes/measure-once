/**
 * usePaginatedContacts — priority sort tests
 *
 * Covers filterSortPaginateCachedContacts() "Priority first" ordering:
 *   - Rank 0: contacts with no lead status sort above everyone else.
 *   - Then by notes_last_contacted ascending (never-contacted first),
 *     tie-break by createdate ascending (first-come-first-serve).
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

describe('filterSortPaginateCachedContacts — Priority first ordering', () => {
  it('places no-lead-status contacts at the very top (rank 0)', () => {
    const contacts = [
      // statused, never contacted — would otherwise sort first
      makeContact('1', { hs_lead_status: 'OPEN_DEAL', notes_last_contacted: null, createdate: '2024-01-01T00:00:00.000Z' }),
      // no status, but recently contacted — still wins on rank 0
      makeContact('2', { hs_lead_status: '', notes_last_contacted: '2024-06-01T00:00:00.000Z', createdate: '2024-06-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, { ...baseParams });
    expect(results[0].id).toBe('2');
  });

  it('orders multiple no-status contacts among themselves by last-contacted ascending', () => {
    const contacts = [
      makeContact('a', { hs_lead_status: '', notes_last_contacted: '2024-06-01T00:00:00.000Z' }),
      makeContact('b', { hs_lead_status: '', notes_last_contacted: null }),
      makeContact('c', { hs_lead_status: '', notes_last_contacted: '2024-01-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, { ...baseParams });
    // never-contacted (b) first, then ascending by last-contacted (c before a)
    expect(results.map(r => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('places never-contacted contacts first within the statused group', () => {
    const contacts = [
      makeContact('1', { notes_last_contacted: '2024-03-01T00:00:00.000Z' }),
      makeContact('2', { notes_last_contacted: null }),
      makeContact('3', { notes_last_contacted: '2024-01-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, { ...baseParams });
    expect(results[0].id).toBe('2');
  });

  it('sorts remaining contacts ascending by notes_last_contacted (oldest first)', () => {
    const contacts = [
      makeContact('1', { notes_last_contacted: '2024-06-01T00:00:00.000Z' }),
      makeContact('2', { notes_last_contacted: '2024-01-01T00:00:00.000Z' }),
      makeContact('3', { notes_last_contacted: '2024-03-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, { ...baseParams });
    expect(results.map(r => r.id)).toEqual(['2', '3', '1']);
  });

  it('tie-breaks by createdate ascending (first-come-first-serve) when notes_last_contacted are equal', () => {
    const ts = '2024-03-01T00:00:00.000Z';
    const contacts = [
      makeContact('A', { notes_last_contacted: ts, createdate: '2024-01-01T00:00:00.000Z' }),
      makeContact('B', { notes_last_contacted: ts, createdate: '2024-03-01T00:00:00.000Z' }),
      makeContact('C', { notes_last_contacted: ts, createdate: '2024-02-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, { ...baseParams });
    expect(results.map(r => r.id)).toEqual(['A', 'C', 'B']);
  });

  it('tie-breaks by createdate ascending (first-come-first-serve) for multiple never-contacted contacts', () => {
    const contacts = [
      makeContact('old', { notes_last_contacted: null, createdate: '2024-01-01T00:00:00.000Z' }),
      makeContact('new', { notes_last_contacted: null, createdate: '2024-06-01T00:00:00.000Z' }),
      makeContact('mid', { notes_last_contacted: null, createdate: '2024-03-01T00:00:00.000Z' }),
    ];
    const { results } = filterSortPaginateCachedContacts(contacts, { ...baseParams });
    // Never-contacted "awaiting a call" leads are served oldest-first.
    expect(results.map(r => r.id)).toEqual(['old', 'mid', 'new']);
  });

  it('does not apply priority sort when a leadStatus filter is active', () => {
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
    });
    // priorityFirst && !leadStatus is false → falls back to newest-created-first
    // '2' (2024-02-01) is newer than '1' (2024-01-01)
    expect(results.map(r => r.id)).toEqual(['2', '1']);
  });
});
