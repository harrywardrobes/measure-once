import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('UnmatchedSubCard — room count in expanded panel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const noop = () => {};

  function expand() {
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  }

  it('renders the Rooms label and count when room_count is a non-zero string', () => {
    render(<UnmatchedSubCard sub={{ ...BASE_SUB, room_count: '4' }} onLinked={noop} />);
    expand();
    expect(screen.getByText('Rooms')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('does not render the Rooms section when room_count is null', () => {
    render(<UnmatchedSubCard sub={{ ...BASE_SUB, room_count: null }} onLinked={noop} />);
    expand();
    expect(screen.queryByText('Rooms')).not.toBeInTheDocument();
  });

  it('does not render the Rooms section when room_count is the string "0"', () => {
    render(<UnmatchedSubCard sub={{ ...BASE_SUB, room_count: '0' }} onLinked={noop} />);
    expand();
    expect(screen.queryByText('Rooms')).not.toBeInTheDocument();
  });
});
