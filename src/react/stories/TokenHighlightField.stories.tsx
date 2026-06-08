import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {
  TokenHighlightField,
  type TokenHighlightFieldHandle,
} from '../components/TokenHighlightField';

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

function ClickToInsert() {
  const [subject, setSubject] = useState('Hi , welcome aboard');
  const [body, setBody] = useState(
    'Hello ,\n\nThanks for choosing us. We look forward to your visit.',
  );
  const subjectRef = useRef<TokenHighlightFieldHandle>(null);
  const bodyRef = useRef<TokenHighlightFieldHandle>(null);
  const lastFocused = useRef<'subject' | 'body' | null>(null);

  const insert = (name: string) => {
    if (lastFocused.current === 'subject') {
      subjectRef.current?.insertAtCaret(`{{${name}}}`);
    } else if (lastFocused.current === 'body') {
      bodyRef.current?.insertAtCaret(`{{${name}}}`);
    } else {
      bodyRef.current?.insertAtCaret(`{{${name}}}`, { append: true });
    }
  };

  return (
    <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Typography variant="caption" color="text.secondary">
        Click a variable to insert it at the caret of the last-focused field:
      </Typography>
      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
        {KNOWN.map((v) => (
          <Chip
            key={v}
            label={`{{${v}}}`}
            size="small"
            variant="outlined"
            clickable
            onClick={() => insert(v)}
          />
        ))}
      </Stack>
      <TokenHighlightField
        ref={subjectRef}
        label="Subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        onFocus={() => { lastFocused.current = 'subject'; }}
        knownVariables={KNOWN}
      />
      <TokenHighlightField
        ref={bodyRef}
        label="Body (plain text)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onFocus={() => { lastFocused.current = 'body'; }}
        knownVariables={KNOWN}
        multiline
        minRows={6}
      />
    </Stack>
  );
}

export const ClickToInsertChips: Story = {
  name: 'Click-to-insert variable chips',
  render: () => <ClickToInsert />,
};
