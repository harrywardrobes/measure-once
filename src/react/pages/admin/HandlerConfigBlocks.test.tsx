import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import {
  ScheduleVisitConfig,
  ShowMessageConfig,
  StartDesignVisitConfig,
  DeliveryWindowConfig,
  InstallationSlotConfig
} from './HandlerConfigBlocks';

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Find a number input by its current value — useful when there's no label
 * text we can easily query by (e.g. the duration field in ScheduleVisitConfig).
 */
function getDurationInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) throw new Error('No number input found in container');
  return input;
}

// ── ScheduleVisitConfig ──────────────────────────────────────────────────────

describe('ScheduleVisitConfig', () => {
  it('renders with default props', () => {
    const { container } = render(<ScheduleVisitConfig />);
    const durInput = getDurationInput(container);
    expect(durInput.value).toBe('60');
    // Default visitType is 'survey' — its label should be displayed in the combobox
    expect(screen.getByRole('combobox')).toHaveTextContent('Survey');
  });

  it('renders with supplied initial props', () => {
    const { container } = render(
      <ScheduleVisitConfig
        defaultVisitType="installation"
        defaultDurationMin={120}
      />,
    );
    expect(getDurationInput(container).value).toBe('120');
    // Supplied visitType 'installation' should be visible in the combobox
    expect(screen.getByRole('combobox')).toHaveTextContent('Installation');
  });

  it('calls onChange with correct shape when duration changes', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ScheduleVisitConfig defaultDurationMin={60} onChange={onChange} />,
    );
    const durInput = getDurationInput(container);
    fireEvent.change(durInput, { target: { value: '90' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDurationMin: 90 }),
    );
  });

  it('calls onChange with empty string when duration field is cleared', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ScheduleVisitConfig defaultDurationMin={60} onChange={onChange} />,
    );
    fireEvent.change(getDurationInput(container), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDurationMin: '' }),
    );
  });

  it('shows duration error for value below 5', () => {
    const { container } = render(<ScheduleVisitConfig defaultDurationMin={60} />);
    fireEvent.change(getDurationInput(container), { target: { value: '2' } });
    expect(screen.getByText(/Must be between 5 and 1440 minutes/i)).toBeInTheDocument();
  });

  it('shows duration error for value above 1440', () => {
    const { container } = render(<ScheduleVisitConfig defaultDurationMin={60} />);
    fireEvent.change(getDurationInput(container), { target: { value: '2000' } });
    expect(screen.getByText(/Must be between 5 and 1440 minutes/i)).toBeInTheDocument();
  });

  it('does not show duration error when field is empty (optional)', () => {
    const { container } = render(<ScheduleVisitConfig defaultDurationMin={60} />);
    fireEvent.change(getDurationInput(container), { target: { value: '' } });
    expect(screen.queryByText(/Must be between 5 and 1440 minutes/i)).toBeNull();
  });

  it('does not show duration error for a valid boundary value (5)', () => {
    const { container } = render(<ScheduleVisitConfig defaultDurationMin={60} />);
    fireEvent.change(getDurationInput(container), { target: { value: '5' } });
    expect(screen.queryByText(/Must be between 5 and 1440 minutes/i)).toBeNull();
  });

  it('does not show duration error for a valid boundary value (1440)', () => {
    const { container } = render(<ScheduleVisitConfig defaultDurationMin={60} />);
    fireEvent.change(getDurationInput(container), { target: { value: '1440' } });
    expect(screen.queryByText(/Must be between 5 and 1440 minutes/i)).toBeNull();
  });
});

// ── ShowMessageConfig ────────────────────────────────────────────────────────

describe('ShowMessageConfig', () => {
  it('renders with default (empty) props', () => {
    render(<ShowMessageConfig />);
    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].getAttribute('value')).toBe('');
  });

  it('renders with supplied initial title and message', () => {
    render(
      <ShowMessageConfig
        defaultTitle="Hello"
        defaultMessage="World"
      />,
    );
    const inputs = screen.getAllByRole('textbox');
    expect(inputs[0]).toHaveValue('Hello');
    expect(inputs[1]).toHaveValue('World');
  });

  it('calls onChange with correct shape when title changes', () => {
    const onChange = vi.fn();
    render(<ShowMessageConfig defaultTitle="Old" defaultMessage="Msg" onChange={onChange} />);
    const [titleInput] = screen.getAllByRole('textbox');
    fireEvent.change(titleInput, { target: { value: 'New Title' } });
    expect(onChange).toHaveBeenCalledWith({ title: 'New Title', message: 'Msg' });
  });

  it('calls onChange with correct shape when message changes', () => {
    const onChange = vi.fn();
    render(<ShowMessageConfig defaultTitle="T" defaultMessage="Old" onChange={onChange} />);
    const [, msgInput] = screen.getAllByRole('textbox');
    fireEvent.change(msgInput, { target: { value: 'New message' } });
    expect(onChange).toHaveBeenCalledWith({ title: 'T', message: 'New message' });
  });

  it('includes placeholder text for the message field', () => {
    render(<ShowMessageConfig />);
    expect(
      screen.getByPlaceholderText(/What should the operator do when they click this label/i),
    ).toBeInTheDocument();
  });

  it('does not show a required error on initial render when message is empty', () => {
    render(<ShowMessageConfig defaultMessage="" />);
    expect(screen.queryByText(/Message is required/i)).toBeNull();
  });

  it('shows required error after clearing the message field', () => {
    render(<ShowMessageConfig defaultMessage="Hello" />);
    const [, msgInput] = screen.getAllByRole('textbox');
    fireEvent.change(msgInput, { target: { value: '' } });
    expect(screen.getByText(/Message is required/i)).toBeInTheDocument();
  });

  it('clears the required error when a non-empty message is entered', () => {
    render(<ShowMessageConfig defaultMessage="Hello" />);
    const [, msgInput] = screen.getAllByRole('textbox');
    fireEvent.change(msgInput, { target: { value: '' } });
    expect(screen.getByText(/Message is required/i)).toBeInTheDocument();
    fireEvent.change(msgInput, { target: { value: 'Back again' } });
    expect(screen.queryByText(/Message is required/i)).toBeNull();
  });
});

// ── StartDesignVisitConfig ───────────────────────────────────────────────────

describe('StartDesignVisitConfig', () => {
  const LEAD_STATUSES = [
    { key: 'ls_a', label: 'Status A' },
    { key: 'ls_b', label: 'Status B' }
  ];

  it('renders with default props (90 min, no status pre-selected)', () => {
    const { container } = render(<StartDesignVisitConfig />);
    expect(getDurationInput(container).value).toBe('90');
    // Both status selects should show the empty "— none —" placeholder
    const combos = screen.getAllByRole('combobox');
    expect(combos[0]).toHaveTextContent('— none —');
    expect(combos[1]).toHaveTextContent('— none —');
  });

  it('renders with supplied initial props', () => {
    const { container } = render(
      <StartDesignVisitConfig
        defaultDurationMin={120}
        termsAndConditions="My terms"
        intermediateLeadStatus="ls_a"
        submittedLeadStatus="sub_x"
        leadStatuses={LEAD_STATUSES}
      />,
    );
    expect(getDurationInput(container).value).toBe('120');
    expect(screen.getByDisplayValue('My terms')).toBeInTheDocument();
    // Initial status selections should be visible in the comboboxes
    const combos = screen.getAllByRole('combobox');
    expect(combos[0]).toHaveTextContent('Status A');
    expect(combos[1]).toHaveTextContent('sub_x');
  });

  it('calls onChange with correct shape when duration changes', () => {
    const onChange = vi.fn();
    const { container } = render(
      <StartDesignVisitConfig defaultDurationMin={90} onChange={onChange} />,
    );
    fireEvent.change(getDurationInput(container), { target: { value: '45' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDurationMin: 45 }),
    );
  });

  it('calls onChange when terms field changes', () => {
    const onChange = vi.fn();
    render(
      <StartDesignVisitConfig
        termsAndConditions=""
        onChange={onChange}
      />,
    );
    const termsInput = screen.getByPlaceholderText(/Your terms and conditions/i);
    fireEvent.change(termsInput, { target: { value: 'New terms' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ termsAndConditions: 'New terms' }),
    );
  });

  it('shows duration error for value below 5', () => {
    const { container } = render(<StartDesignVisitConfig />);
    fireEvent.change(getDurationInput(container), { target: { value: '3' } });
    expect(screen.getByText(/Must be between 5 and 1440 minutes/i)).toBeInTheDocument();
  });

  it('shows duration error for value above 1440', () => {
    const { container } = render(<StartDesignVisitConfig />);
    fireEvent.change(getDurationInput(container), { target: { value: '9999' } });
    expect(screen.getByText(/Must be between 5 and 1440 minutes/i)).toBeInTheDocument();
  });

  it('does not show duration error when field is empty', () => {
    const { container } = render(<StartDesignVisitConfig />);
    fireEvent.change(getDurationInput(container), { target: { value: '' } });
    expect(screen.queryByText(/Must be between 5 and 1440 minutes/i)).toBeNull();
  });

  it('renders lead status options in the intermediate status select when opened', () => {
    render(
      <StartDesignVisitConfig leadStatuses={LEAD_STATUSES} />,
    );
    // Open the first combobox (intermediate status)
    const [intermediateCombo] = screen.getAllByRole('combobox');
    fireEvent.mouseDown(intermediateCombo);
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Status A')).toBeInTheDocument();
    expect(within(listbox).getByText('Status B')).toBeInTheDocument();
  });

  it('renders lead status options in the submitted status select when opened', () => {
    render(
      <StartDesignVisitConfig leadStatuses={LEAD_STATUSES} />,
    );
    // Open the second combobox (submitted status)
    const combos = screen.getAllByRole('combobox');
    fireEvent.mouseDown(combos[1]);
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Status A')).toBeInTheDocument();
    expect(within(listbox).getByText('Status B')).toBeInTheDocument();
  });

  it('calls onChange with empty string duration when field cleared', () => {
    const onChange = vi.fn();
    const { container } = render(
      <StartDesignVisitConfig defaultDurationMin={90} onChange={onChange} />,
    );
    fireEvent.change(getDurationInput(container), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDurationMin: '' }),
    );
  });

  it('shows warning alert when intermediateLeadStatusInvalid is true', () => {
    render(
      <StartDesignVisitConfig
        intermediateLeadStatus="deleted_status"
        intermediateLeadStatusInvalid={true}
      />,
    );
    expect(
      screen.getByText(/This lead status no longer exists/i),
    ).toBeInTheDocument();
  });

  it('shows warning alert when submittedLeadStatusInvalid is true', () => {
    render(
      <StartDesignVisitConfig
        submittedLeadStatus="deleted_status"
        submittedLeadStatusInvalid={true}
      />,
    );
    expect(
      screen.getByText(/This lead status no longer exists/i),
    ).toBeInTheDocument();
  });

  it('does not show warning alert when both invalid flags are false', () => {
    render(
      <StartDesignVisitConfig
        intermediateLeadStatus="live_status"
        submittedLeadStatus="live_sub"
        intermediateLeadStatusInvalid={false}
        submittedLeadStatusInvalid={false}
      />,
    );
    expect(screen.queryByText(/This lead status no longer exists/i)).toBeNull();
  });

  it('shows two warning alerts when both invalid flags are true', () => {
    render(
      <StartDesignVisitConfig
        intermediateLeadStatus="gone_inter"
        submittedLeadStatus="gone_sub"
        intermediateLeadStatusInvalid={true}
        submittedLeadStatusInvalid={true}
      />,
    );
    const alerts = screen.getAllByText(/This lead status no longer exists/i);
    expect(alerts).toHaveLength(2);
  });
});

// ── DeliveryWindowConfig ─────────────────────────────────────────────────────

describe('DeliveryWindowConfig', () => {
  it('renders with default (empty title)', () => {
    render(<DeliveryWindowConfig />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('');
  });

  it('renders with supplied initial props', () => {
    render(
      <DeliveryWindowConfig
        defaultTitle="Delivery"
      />,
    );
    expect(screen.getByRole('textbox')).toHaveValue('Delivery');
  });

  it('calls onChange with correct shape when title changes', () => {
    const onChange = vi.fn();
    render(<DeliveryWindowConfig defaultTitle="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Window' } });
    expect(onChange).toHaveBeenCalledWith({ defaultTitle: 'Window' });
  });

  it('includes placeholder text on the title field', () => {
    render(<DeliveryWindowConfig />);
    expect(screen.getByPlaceholderText(/Delivery window/i)).toBeInTheDocument();
  });
});

// ── InstallationSlotConfig ───────────────────────────────────────────────────

describe('InstallationSlotConfig', () => {
  it('renders with default props (240 min, empty title)', () => {
    const { container } = render(<InstallationSlotConfig />);
    expect(getDurationInput(container).value).toBe('240');
    const textInputs = screen.getAllByRole('textbox');
    expect(textInputs).toHaveLength(1);
    expect(textInputs[0]).toHaveValue('');
  });

  it('renders with supplied initial props', () => {
    const { container } = render(
      <InstallationSlotConfig
        defaultDurationMin={480}
        defaultTitle="Full day install"
      />,
    );
    expect(getDurationInput(container).value).toBe('480');
    expect(screen.getByRole('textbox')).toHaveValue('Full day install');
  });

  it('calls onChange with correct shape when duration changes', () => {
    const onChange = vi.fn();
    const { container } = render(
      <InstallationSlotConfig defaultDurationMin={240} onChange={onChange} />,
    );
    fireEvent.change(getDurationInput(container), { target: { value: '480' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDurationMin: 480 }),
    );
  });

  it('calls onChange with correct shape when title changes', () => {
    const onChange = vi.fn();
    render(
      <InstallationSlotConfig defaultTitle="" onChange={onChange} />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Install day' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ defaultTitle: 'Install day' }),
    );
  });

  it('shows duration error for value below 5', () => {
    const { container } = render(<InstallationSlotConfig />);
    fireEvent.change(getDurationInput(container), { target: { value: '1' } });
    expect(screen.getByText(/Must be between 5 and 1440 minutes/i)).toBeInTheDocument();
  });

  it('shows duration error for value above 1440', () => {
    const { container } = render(<InstallationSlotConfig />);
    fireEvent.change(getDurationInput(container), { target: { value: '1441' } });
    expect(screen.getByText(/Must be between 5 and 1440 minutes/i)).toBeInTheDocument();
  });

  it('does not show duration error when field is empty (optional)', () => {
    const { container } = render(<InstallationSlotConfig />);
    fireEvent.change(getDurationInput(container), { target: { value: '' } });
    expect(screen.queryByText(/Must be between 5 and 1440 minutes/i)).toBeNull();
  });

  it('does not show duration error for valid boundary value (5)', () => {
    const { container } = render(<InstallationSlotConfig />);
    fireEvent.change(getDurationInput(container), { target: { value: '5' } });
    expect(screen.queryByText(/Must be between 5 and 1440 minutes/i)).toBeNull();
  });

  it('calls onChange with empty string duration when field cleared', () => {
    const onChange = vi.fn();
    const { container } = render(
      <InstallationSlotConfig defaultDurationMin={240} onChange={onChange} />,
    );
    fireEvent.change(getDurationInput(container), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDurationMin: '' }),
    );
  });
});
