import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Stack from '@mui/material/Stack';
import { TokenHighlightField } from '../components/TokenHighlightField';

const meta: Meta<typeof TokenHighlightField> = {
  title: 'Forms/TokenHighlightField',
  tags: ['autodocs'],
  component: TokenHighlightField,
  parameters: {
    docs: {
      description: {
        component:
          'Outlined text field that highlights `{{token}}` placeholders as you ' +
          'type. Known variables are tinted green; well-formed but unknown ones ' +
          'get a red, spell-checker-style wavy underline; and malformed ' +
          'placeholders with the wrong number of curly braces (e.g. ' +
          '`{firstName}` or `{{firstName}`) get an amber wavy underline so ' +
          'brace typos are obvious instantly.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof TokenHighlightField>;

const KNOWN = ['firstName', 'lastName', 'companyName', 'visitDate'];

function Interactive({
  initial,
  multiline,
  minRows,
  label,
}: {
  initial: string;
  multiline?: boolean;
  minRows?: number;
  label: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Stack sx={{ maxWidth: 560 }}>
      <TokenHighlightField
        label={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        knownVariables={KNOWN}
        multiline={multiline}
        minRows={minRows}
      />
    </Stack>
  );
}

export const SingleLineSubject: Story = {
  name: 'Single line — subject with mixed tokens',
  render: () => (
    <Interactive
      label="Subject"
      initial="Hi {{firstName}}, your visit on {{vistDate}} is confirmed"
    />
  ),
};

export const MultilineBody: Story = {
  name: 'Multiline — body with known + unknown tokens',
  render: () => (
    <Interactive
      label="Body (plain text)"
      multiline
      minRows={6}
      initial={
        'Hello {{firstName}} {{lastName}},\n\n' +
        'Thanks for choosing {{companyName}}. We have you booked for ' +
        '{{visitDate}}.\n\n' +
        'Please reply if {{phoneNumber}} is the best number to reach you.\n\n' +
        'Warm regards,\nThe {{companyName}} team'
      }
    />
  ),
};

export const MalformedPlaceholders: Story = {
  name: 'Malformed — missing or extra braces',
  render: () => (
    <Interactive
      label="Body (plain text)"
      multiline
      minRows={6}
      initial={
        'Hi {firstName},\n\n' +
        'Your visit with {{companyName} is booked for {{visitDate}}.\n\n' +
        'A well-formed token like {{lastName}} stays green; the single-brace ' +
        '{firstName} and the missing-brace {{companyName} get an amber wavy ' +
        'underline instead.'
      }
    />
  ),
};

export const AllKnown: Story = {
  name: 'All tokens recognised',
  render: () => (
    <Interactive
      label="Subject"
      initial="Hi {{firstName}} {{lastName}} from {{companyName}}"
    />
  ),
};

export const NoTokens: Story = {
  name: 'Plain text, no tokens',
  render: () => (
    <Interactive label="Footer" multiline minRows={2} initial="Sent from Measure Once." />
  ),
};
