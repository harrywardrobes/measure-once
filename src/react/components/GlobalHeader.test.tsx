import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ServiceStatusBadge } from './GlobalHeader';

describe('ServiceStatusBadge colour guards', () => {
  it('error status icon colour is #fca5a5 (rgb 252 165 165)', () => {
    const { getByTestId } = render(
      <ServiceStatusBadge service="hubspot" status="error" />,
    );
    const icon = getByTestId('service-status-icon');
    expect(window.getComputedStyle(icon).color).toBe('rgb(252, 165, 165)');
  });

  it('warning status icon colour is #fcd34d (rgb 252 211 77)', () => {
    const { getByTestId } = render(
      <ServiceStatusBadge service="hubspot" status="warning" />,
    );
    const icon = getByTestId('service-status-icon');
    expect(window.getComputedStyle(icon).color).toBe('rgb(252, 211, 77)');
  });

  it('ok status icon colour is #86efac (rgb 134 239 172)', () => {
    const { getByTestId } = render(
      <ServiceStatusBadge service="hubspot" status="ok" />,
    );
    const icon = getByTestId('service-status-icon');
    expect(window.getComputedStyle(icon).color).toBe('rgb(134, 239, 172)');
  });
});
