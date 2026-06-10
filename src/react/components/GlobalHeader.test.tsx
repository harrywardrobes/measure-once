import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ServiceStatusBadge, OfflinePill } from './GlobalHeader';

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

  it('checking status icon colour is rgba(255,255,255,0.5) — neutral', () => {
    const { getByTestId } = render(
      <ServiceStatusBadge service="hubspot" status="checking" />,
    );
    const icon = getByTestId('service-status-icon');
    expect(window.getComputedStyle(icon).color).toBe('rgba(255, 255, 255, 0.5)');
  });
});

describe('ServiceStatusBadge badge dot colour guards', () => {
  it('error status badge dot colour is #ef4444 (rgb 239 68 68)', () => {
    const { container } = render(
      <ServiceStatusBadge service="hubspot" status="error" />,
    );
    const dot = container.querySelector('.MuiBadge-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(window.getComputedStyle(dot).backgroundColor).toBe('rgb(239, 68, 68)');
  });

  it('warning status badge dot colour is #f59e0b (rgb 245 158 11)', () => {
    const { container } = render(
      <ServiceStatusBadge service="hubspot" status="warning" />,
    );
    const dot = container.querySelector('.MuiBadge-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(window.getComputedStyle(dot).backgroundColor).toBe('rgb(245, 158, 11)');
  });

  it('ok status badge dot colour is #22c55e (rgb 34 197 94)', () => {
    const { container } = render(
      <ServiceStatusBadge service="hubspot" status="ok" />,
    );
    const dot = container.querySelector('.MuiBadge-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(window.getComputedStyle(dot).backgroundColor).toBe('rgb(34, 197, 94)');
  });

  it('checking status badge dot colour is rgba(255,255,255,0.35) — neutral', () => {
    const { container } = render(
      <ServiceStatusBadge service="hubspot" status="checking" />,
    );
    const dot = container.querySelector('.MuiBadge-dot') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(window.getComputedStyle(dot).backgroundColor).toBe('rgba(255, 255, 255, 0.35)');
  });
});

describe('OfflinePill colour guards', () => {
  it('offline pill text colour is #fcd34d (rgb 252 211 77)', () => {
    const { getByTestId } = render(<OfflinePill />);
    const pill = getByTestId('offline-pill');
    expect(window.getComputedStyle(pill).color).toBe('rgb(252, 211, 77)');
  });

  it('offline pill background colour is rgba(245,158,11,0.16)', () => {
    const { getByTestId } = render(<OfflinePill />);
    const pill = getByTestId('offline-pill');
    expect(window.getComputedStyle(pill).backgroundColor).toBe('rgba(245, 158, 11, 0.16)');
  });

  it('offline pill border colour is rgba(252,211,77,0.4)', () => {
    const { getByTestId } = render(<OfflinePill />);
    const pill = getByTestId('offline-pill');
    expect(window.getComputedStyle(pill).borderTopColor).toBe('rgba(252, 211, 77, 0.4)');
  });

  it('offline pill border width is 1px', () => {
    const { getByTestId } = render(<OfflinePill />);
    const pill = getByTestId('offline-pill');
    expect(window.getComputedStyle(pill).borderTopWidth).toBe('1px');
  });

  it('offline pill border radius is 8px', () => {
    const { getByTestId } = render(<OfflinePill />);
    const pill = getByTestId('offline-pill');
    expect(window.getComputedStyle(pill).borderRadius).toBe('8px');
  });
});
