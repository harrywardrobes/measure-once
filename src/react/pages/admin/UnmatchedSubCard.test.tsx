import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('./adminApi', () => ({
  api: vi.fn(() => Promise.resolve({})),
  toast: vi.fn(),
  fmtDate: vi.fn(() => '1 Jan 2024'),
  emitAdminChange: vi.fn(),
  onAdminChange: vi.fn(() => () => {}),
  setRequestsBadge: vi.fn(),
}));

vi.mock('../../utils/phoneFormatters', () => ({
  formatPhone: vi.fn((v: unknown) => (v != null ? String(v) : '')),
}));

import { UnmatchedSubCard, type UnmatchedSub } from './AdminRequestsPage';

// ── Fixture ───────────────────────────────────────────────────────────────────

const BASE_SUB: UnmatchedSub = {
  id: 1,
  contact_name: 'Jane Smith',
  contact_email: 'jane@example.com',
  contact_phone: null,
  corrected_email: null,
  corrected_mobile: null,
  address_line1: null,
  city: null,
  postcode: null,
  room_count: null,
  room_notes: null,
  photo_keys: [],
  photoUrls: [],
  submitted_at: '2024-01-01T00:00:00Z',
  created_at: '2024-01-01T00:00:00Z',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('UnmatchedSubCard — corrected badges', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const noop = () => {};

  it('shows a "corrected" chip next to the email when corrected_email is set', () => {
    render(
      <UnmatchedSubCard
        sub={{ ...BASE_SUB, corrected_email: 'corrected@example.com' }}
        onLinked={noop}
      />,
    );
    expect(screen.getAllByText('corrected')).toHaveLength(1);
  });

  it('shows a "corrected" chip next to the phone when corrected_mobile is set', () => {
    render(
      <UnmatchedSubCard
        sub={{ ...BASE_SUB, corrected_mobile: '07700900000' }}
        onLinked={noop}
      />,
    );
    expect(screen.getAllByText('corrected')).toHaveLength(1);
  });

  it('shows no "corrected" chip when neither correction field is set', () => {
    render(<UnmatchedSubCard sub={BASE_SUB} onLinked={noop} />);
    expect(screen.queryAllByText('corrected')).toHaveLength(0);
  });

  it('shows two "corrected" chips when both corrected_email and corrected_mobile are set', () => {
    render(
      <UnmatchedSubCard
        sub={{
          ...BASE_SUB,
          corrected_email: 'corrected@example.com',
          corrected_mobile: '07700900000',
        }}
        onLinked={noop}
      />,
    );
    expect(screen.getAllByText('corrected')).toHaveLength(2);
  });
});
