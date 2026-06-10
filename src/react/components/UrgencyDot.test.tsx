import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { UrgencyDot } from './UrgencyDot';

describe('UrgencyDot', () => {
  it('renders a red dot with correct aria-label and title for urgency="red"', () => {
    const { container } = render(<UrgencyDot urgency="red" />);
    const dot = container.querySelector('span');
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-label', 'Urgent');
    expect(dot).toHaveAttribute('title', 'Urgent: task due within 1 working day');
  });

  it('renders an orange dot with correct aria-label and title for urgency="orange"', () => {
    const { container } = render(<UrgencyDot urgency="orange" />);
    const dot = container.querySelector('span');
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-label', 'Task due soon');
    expect(dot).toHaveAttribute('title', 'Task due within 2 working days');
  });

  it('renders nothing for urgency=null', () => {
    const { container } = render(<UrgencyDot urgency={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('red dot is accessible via aria-label', () => {
    render(<UrgencyDot urgency="red" />);
    expect(screen.getByRole('generic', { name: 'Urgent' })).toBeInTheDocument();
  });

  it('orange dot is accessible via aria-label', () => {
    render(<UrgencyDot urgency="orange" />);
    expect(screen.getByRole('generic', { name: 'Task due soon' })).toBeInTheDocument();
  });
});
