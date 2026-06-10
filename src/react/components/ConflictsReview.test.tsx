import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import ConflictsReview from './ConflictsReview';
import type { ConflictEntry } from '../lib/offlineQueue';

const STUB_CONFLICT: ConflictEntry = {
  id: 1,
  area: 'customer',
  label: 'Test contact',
  url: '/api/contacts/1',
  method: 'PATCH',
  resolution: 'last_write_wins',
  detectedAt: Date.now(),
};

describe('ConflictsReview colour guards', () => {
  it('conflicts pill colour is #fdba74 (rgb 253 186 116)', () => {
    const { getByTestId } = render(
      <ConflictsReview conflicts={[STUB_CONFLICT]} onDismissAll={async () => {}} />,
    );
    const pill = getByTestId('conflicts-pill');
    expect(window.getComputedStyle(pill).color).toBe('rgb(253, 186, 116)');
  });
});
