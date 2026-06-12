import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { AddressInput } from '../components/AddressInput';
import { formatAddress, emptyAddress, type StructuredAddress } from '../../../shared/address';

const meta: Meta<typeof AddressInput> = {
  title: 'Components/AddressInput',
  component: AddressInput,
  parameters: { layout: 'padded' },
  argTypes: {
    required: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
};
export default meta;

type Story = StoryObj<typeof AddressInput>;

function Harness({ initial, required, disabled }: { initial: StructuredAddress; required?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState<StructuredAddress>(initial);
  return (
    <Box sx={{ maxWidth: 520 }}>
      <AddressInput value={value} onChange={setValue} required={required} disabled={disabled} />
      <Typography variant="caption" sx={{ display: 'block', mt: 2, color: 'var(--neutral-600)' }}>
        Formatted: {formatAddress(value) || '—'}
      </Typography>
      <Box component="pre" sx={{ mt: 1, fontSize: '.7rem', color: 'var(--neutral-500)', whiteSpace: 'pre-wrap' }}>
        {JSON.stringify(value, null, 2)}
      </Box>
    </Box>
  );
}

export const Empty: Story = {
  render: () => <Harness initial={emptyAddress()} />,
};

export const Required: Story = {
  render: () => <Harness initial={emptyAddress()} required />,
};

export const UkPrefilled: Story = {
  render: () => (
    <Harness
      initial={{
        addressLines: ['12 Baker Street', 'Marylebone'],
        locality: 'London',
        administrativeArea: 'Greater London',
        postalCode: 'NW1 6XE',
        countryCode: 'GB',
      }}
    />
  ),
};

export const UsPrefilled: Story = {
  render: () => (
    <Harness
      initial={{
        addressLines: ['1600 Pennsylvania Avenue NW'],
        locality: 'Washington',
        administrativeArea: 'DC',
        postalCode: '20500',
        countryCode: 'US',
      }}
    />
  ),
};

export const Disabled: Story = {
  render: () => (
    <Harness
      initial={{
        addressLines: ['12 Baker Street'],
        locality: 'London',
        administrativeArea: '',
        postalCode: 'NW1 6XE',
        countryCode: 'GB',
      }}
      disabled
    />
  ),
};
