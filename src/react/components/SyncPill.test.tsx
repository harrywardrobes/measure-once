import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import SyncPill from './SyncPill';

describe('SyncPill colour guards', () => {
  it('failed state pill colour is #fca5a5 (rgb 252 165 165)', () => {
    const { getByTestId } = render(
      <SyncPill
        counts={{ total: 1, pending: 0, syncing: 0, failed: 1 }}
        failures={[]}
      />,
    );
    const pill = getByTestId('sync-pill');
    expect(window.getComputedStyle(pill).color).toBe('rgb(252, 165, 165)');
  });

  it('syncing state pill colour is #93c5fd (rgb 147 197 253)', () => {
    const { getByTestId } = render(
      <SyncPill
        counts={{ total: 1, pending: 0, syncing: 1, failed: 0 }}
        failures={[]}
      />,
    );
    const pill = getByTestId('sync-pill');
    expect(window.getComputedStyle(pill).color).toBe('rgb(147, 197, 253)');
  });

  it('pending state pill colour is #fcd34d (rgb 252 211 77)', () => {
    const { getByTestId } = render(
      <SyncPill
        counts={{ total: 1, pending: 1, syncing: 0, failed: 0 }}
        failures={[]}
      />,
    );
    const pill = getByTestId('sync-pill');
    expect(window.getComputedStyle(pill).color).toBe('rgb(252, 211, 77)');
  });
});
