import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { AccessRequestGate } from './AccessRequestGate';

describe('AccessRequestGate GateStatusBadge colour guards', () => {
  it('confirmed state badge background is #dcfce7 (rgb 220 252 231)', () => {
    const { getByTestId } = render(
      <AccessRequestGate embedded={{ view: 'confirmed' }} />,
    );
    const badge = getByTestId('gate-status-badge');
    expect(window.getComputedStyle(badge).backgroundColor).toBe('rgb(220, 252, 231)');
  });

  it('confirmed state badge colour is #16a34a (rgb 22 163 74)', () => {
    const { getByTestId } = render(
      <AccessRequestGate embedded={{ view: 'confirmed' }} />,
    );
    const badge = getByTestId('gate-status-badge');
    expect(window.getComputedStyle(badge).color).toBe('rgb(22, 163, 74)');
  });

  it('already_approved state badge background is #dcfce7 (rgb 220 252 231)', () => {
    const { getByTestId } = render(
      <AccessRequestGate embedded={{ view: 'already_approved' }} />,
    );
    const badge = getByTestId('gate-status-badge');
    expect(window.getComputedStyle(badge).backgroundColor).toBe('rgb(220, 252, 231)');
  });

  it('email_conflict state badge background is #fee2e2 (rgb 254 226 226)', () => {
    const { getByTestId } = render(
      <AccessRequestGate embedded={{ view: 'email_conflict' }} />,
    );
    const badge = getByTestId('gate-status-badge');
    expect(window.getComputedStyle(badge).backgroundColor).toBe('rgb(254, 226, 226)');
  });

  it('email_conflict state badge colour is #dc2626 (rgb 220 38 38)', () => {
    const { getByTestId } = render(
      <AccessRequestGate embedded={{ view: 'email_conflict' }} />,
    );
    const badge = getByTestId('gate-status-badge');
    expect(window.getComputedStyle(badge).color).toBe('rgb(220, 38, 38)');
  });

  it('pending state badge background is #fef3c7 (rgb 254 243 199)', () => {
    const { getByTestId } = render(
      <AccessRequestGate embedded={{ view: 'pending' }} />,
    );
    const badge = getByTestId('gate-status-badge');
    expect(window.getComputedStyle(badge).backgroundColor).toBe('rgb(254, 243, 199)');
  });

  it('pending state badge colour is #d97706 (rgb 217 119 6)', () => {
    const { getByTestId } = render(
      <AccessRequestGate embedded={{ view: 'pending' }} />,
    );
    const badge = getByTestId('gate-status-badge');
    expect(window.getComputedStyle(badge).color).toBe('rgb(217, 119, 6)');
  });
});
