import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { filterSortPaginateCachedContacts, PRIORITY_ACTIVE_DAYS } from './usePaginatedContacts';
import type { PaginatedContact } from './usePaginatedContacts';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeContact(id: string, lastmodifieddate?: string): PaginatedContact {
  return {
    id,
    properties: {
      firstname: `Contact${id}`,
      lastname: 'Test',
      email: `contact${id}@example.com`,
      createdate: '2024-01-01T00:00:00.000Z',
      lastmodifieddate,
    },
  };
}

const BASE_PARAMS = {
  leadStatus: '',
  stage: '',
  sortBy: 'priority',
  search: '',
  showArchived: false,
  page: 1,
  limit: 25,
  priorityFirst: true,
};

describe('filterSortPaginateCachedContacts — priority-active filter', () => {
  const NOW = new Date('2026-06-24T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) priority sort hides contacts whose lastmodifieddate is older than 60 days', () => {
    const recentDate = new Date(NOW - 10 * DAY_MS).toISOString();
    const staleDate  = new Date(NOW - 70 * DAY_MS).toISOString();

    const recent = makeContact('1', recentDate);
    const stale  = makeContact('2', staleDate);

    const { results, total } = filterSortPaginateCachedContacts(
      [recent, stale],
      { ...BASE_PARAMS, priorityFirst: true, search: '' },
    );

    const ids = results.map((c) => c.id);
    expect(ids).toContain('1');
    expect(ids).not.toContain('2');
    expect(total).toBe(1);
  });

  it('(a) contact exactly at the 60-day boundary is kept (>= cutoff)', () => {
    const exactCutoff = new Date(NOW - PRIORITY_ACTIVE_DAYS * DAY_MS).toISOString();
    const contact = makeContact('3', exactCutoff);

    const { results } = filterSortPaginateCachedContacts(
      [contact],
      { ...BASE_PARAMS, priorityFirst: true, search: '' },
    );

    expect(results.map((c) => c.id)).toContain('3');
  });

  it('(a) contact with missing lastmodifieddate passes through (keep behaviour)', () => {
    const noDate = makeContact('4', undefined);

    const { results } = filterSortPaginateCachedContacts(
      [noDate],
      { ...BASE_PARAMS, priorityFirst: true, search: '' },
    );

    expect(results.map((c) => c.id)).toContain('4');
  });

  it('(b) priority sort + non-empty search returns stale contacts that match the query', () => {
    const recentDate = new Date(NOW - 10 * DAY_MS).toISOString();
    const staleDate  = new Date(NOW - 70 * DAY_MS).toISOString();

    const recent = makeContact('5', recentDate);
    const stale  = { ...makeContact('6', staleDate), properties: { ...makeContact('6', staleDate).properties, firstname: 'Stale', lastname: 'Person' } };

    const { results, total } = filterSortPaginateCachedContacts(
      [recent, stale],
      { ...BASE_PARAMS, priorityFirst: true, search: 'stale' },
    );

    const ids = results.map((c) => c.id);
    expect(ids).toContain('6');
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('(b) search bypasses the age filter entirely (recent contact also returned)', () => {
    const recentDate = new Date(NOW - 10 * DAY_MS).toISOString();
    const staleDate  = new Date(NOW - 70 * DAY_MS).toISOString();

    const recent = { ...makeContact('7', recentDate), properties: { ...makeContact('7', recentDate).properties, firstname: 'Test', lastname: 'Recent' } };
    const stale  = { ...makeContact('8', staleDate),  properties: { ...makeContact('8', staleDate).properties,  firstname: 'Test', lastname: 'Stale'  } };

    const { results } = filterSortPaginateCachedContacts(
      [recent, stale],
      { ...BASE_PARAMS, priorityFirst: true, search: 'test' },
    );

    const ids = results.map((c) => c.id);
    expect(ids).toContain('7');
    expect(ids).toContain('8');
  });

  it('(c) non-priority sort is unaffected by the age filter (stale contacts shown)', () => {
    const recentDate = new Date(NOW - 10 * DAY_MS).toISOString();
    const staleDate  = new Date(NOW - 70 * DAY_MS).toISOString();

    const recent = makeContact('9',  recentDate);
    const stale  = makeContact('10', staleDate);

    for (const sortBy of ['newest', 'name-asc', 'name-desc'] as const) {
      const { results, total } = filterSortPaginateCachedContacts(
        [recent, stale],
        { ...BASE_PARAMS, priorityFirst: false, sortBy, search: '' },
      );

      const ids = results.map((c) => c.id);
      expect(ids).toContain('9');
      expect(ids).toContain('10');
      expect(total).toBe(2);
    }
  });

  it('(c) total and totalPages reflect the post-filter count on priority sort', () => {
    const recentDate = new Date(NOW - 5  * DAY_MS).toISOString();
    const staleDate  = new Date(NOW - 90 * DAY_MS).toISOString();

    const contacts = [
      makeContact('11', recentDate),
      makeContact('12', recentDate),
      makeContact('13', staleDate),
    ];

    const { total, totalPages } = filterSortPaginateCachedContacts(
      contacts,
      { ...BASE_PARAMS, priorityFirst: true, search: '', limit: 25 },
    );

    expect(total).toBe(2);
    expect(totalPages).toBe(1);
  });
});
