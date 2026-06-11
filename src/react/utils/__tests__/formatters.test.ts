import { describe, it, expect } from 'vitest';
import { compactRelativeTime, latestTimestamp } from '../formatters';

const sec = 1000;
const min = 60 * sec;
const hr = 60 * min;
const day = 24 * hr;
const week = 7 * day;

function nowMinus(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe('compactRelativeTime', () => {
  it('returns null for null input', () => {
    expect(compactRelativeTime(null)).toBe(null);
  });

  it('returns null for undefined input', () => {
    expect(compactRelativeTime(undefined)).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(compactRelativeTime('')).toBe(null);
  });

  it('returns null for unparseable string', () => {
    expect(compactRelativeTime('not-a-date')).toBe(null);
  });

  it('returns "now" for a future timestamp', () => {
    const future = new Date(Date.now() + 10 * min).toISOString();
    expect(compactRelativeTime(future)).toBe('now');
  });

  it('returns "now" for exactly 0ms ago', () => {
    const now = new Date();
    expect(compactRelativeTime(now.toISOString(), now)).toBe('now');
  });

  it('returns "now" for 59 seconds ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 59 * sec).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('now');
  });

  it('returns "1min" for 1 minute ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 1 * min).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('1min');
  });

  it('returns "30min" for 30 minutes ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 30 * min).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('30min');
  });

  it('returns "59min" for 59 minutes ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 59 * min).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('59min');
  });

  it('returns "1hr" for 1 hour ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 1 * hr).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('1hr');
  });

  it('returns "8hr" for 8 hours ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 8 * hr).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('8hr');
  });

  it('returns "23hr" for 23 hours ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 23 * hr).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('23hr');
  });

  it('returns "1d" for 1 day ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 1 * day).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('1d');
  });

  it('returns "4d" for 4 days ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 4 * day).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('4d');
  });

  it('returns "6d" for 6 days ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 6 * day).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('6d');
  });

  it('returns "1w" for 7 days ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 7 * day).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('1w');
  });

  it('returns "3w" for 21 days ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 21 * day).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('3w');
  });

  it('returns "1mo" for 28 days ago', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 28 * day).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('1mo');
  });

  it('returns "2mo" for 60 days ago', () => {
    const fixed = new Date('2025-06-01T12:00:00Z');
    const ts = new Date(fixed.getTime() - 60 * day).toISOString();
    expect(compactRelativeTime(ts, fixed)).toBe('2mo');
  });

  it('accepts epoch-ms string input', () => {
    const fixed = new Date('2025-01-01T12:00:00Z');
    const epochMs = String(fixed.getTime() - 5 * hr);
    expect(compactRelativeTime(epochMs, fixed)).toBe('5hr');
  });
});

describe('latestTimestamp', () => {
  it('returns null for all-null inputs', () => {
    expect(latestTimestamp(null, null, undefined)).toBe(null);
  });

  it('returns null for empty call', () => {
    expect(latestTimestamp()).toBe(null);
  });

  it('returns the only valid input', () => {
    const ts = '2025-01-15T10:00:00Z';
    expect(latestTimestamp(null, ts, undefined)).toBe(ts);
  });

  it('returns the most recent of two timestamps', () => {
    const older = '2025-01-10T10:00:00Z';
    const newer = '2025-01-20T10:00:00Z';
    expect(latestTimestamp(older, newer)).toBe(newer);
    expect(latestTimestamp(newer, older)).toBe(newer);
  });

  it('returns the most recent of three timestamps', () => {
    const a = '2025-01-01T00:00:00Z';
    const b = '2025-03-15T12:00:00Z';
    const c = '2025-02-28T06:00:00Z';
    expect(latestTimestamp(a, b, c)).toBe(b);
  });

  it('ignores unparseable values', () => {
    const valid = '2025-06-01T00:00:00Z';
    expect(latestTimestamp('bad-date', valid, 'also-bad')).toBe(valid);
  });

  it('accepts epoch-ms strings', () => {
    const isoDate = '2025-01-01T00:00:00Z';
    const laterMs = String(new Date('2025-06-01T00:00:00Z').getTime());
    expect(latestTimestamp(isoDate, laterMs)).toBe(laterMs);
  });

  it('returns null for all-unparseable inputs', () => {
    expect(latestTimestamp('foo', 'bar', '')).toBe(null);
  });
});
