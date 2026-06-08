import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import { useState } from 'react';
import SyncPill from './SyncPill';
import type { QueueCounts, QueueEntry } from '../lib/offlineQueue';

const now = Date.now();

const SAMPLE_FAILURES: QueueEntry[] = [
  {
    id: 1,
    area: 'visit',
    label: 'Design visit — 14 Oak Lane',
    method: 'PUT',
    url: '/api/design-visits/482',
    recordKey: 'dv:482',
    body: { lead_status: 'Quoted', notes: 'Customer prefers oak veneer doors.' },
    status: 'failed',
    attempts: 5,
    createdAt: now - 1000 * 60 * 60,
    updatedAt: now - 1000 * 60 * 8,
    nextAttemptAt: now,
    lastError: 'Server error 500 — the visit could not be saved.',
  },
  {
    id: 2,
    area: 'photo',
    label: 'Room photo — Kitchen',
    method: 'POST',
    url: '/api/design-visits/482/photos',
    recordKey: 'dv:482',
    formFields: [
      { name: 'room', value: 'Kitchen' },
      { name: 'photo', filename: 'kitchen.jpg', blob: new Blob([]) },
    ],
    status: 'failed',
    attempts: 5,
    createdAt: now - 1000 * 60 * 50,
    updatedAt: now - 1000 * 60 * 4,
    nextAttemptAt: now,
    lastError: 'Upload rejected (413) — the image was too large.',
  },
];

/** One entry per mapped failure category, to preview the plain-language reasons. */
const VARIED_FAILURES: QueueEntry[] = [
  { reason: 'Failed to fetch', label: 'Customer details — Jane Doe', area: 'customer' },
  { reason: 'Unauthorized (401)', label: 'Design visit — 5 Elm Court', area: 'visit' },
  { reason: 'Not Found (404)', label: 'Design visit — 9 Birch Way', area: 'visit' },
  { reason: 'Conflict (409) — version mismatch', label: 'Customer details — Acme Ltd', area: 'customer' },
  { reason: 'Validation failed: postcode is required', label: 'Customer details — Bob Smith', area: 'customer' },
  { reason: 'Upload rejected (413) — the image was too large.', label: 'Room photo — Bathroom', area: 'photo' },
  { reason: 'Server error 500 — the visit could not be saved.', label: 'Design visit — 2 Cedar Rise', area: 'visit' },
  { reason: 'Something completely unexpected happened', label: 'Customer details — Unknown', area: 'customer' },
].map((f, i) => ({
  id: i + 10,
  area: f.area as QueueEntry['area'],
  label: f.label,
  method: 'PUT',
  url: '/api/example',
  status: 'failed',
  attempts: 5,
  createdAt: now - 1000 * 60 * 60,
  updatedAt: now - 1000 * 60 * (i + 1),
  nextAttemptAt: now,
  lastError: f.reason,
}));

const FAILED_COUNTS: QueueCounts = { total: 2, pending: 0, syncing: 0, failed: 2 };
const PENDING_COUNTS: QueueCounts = { total: 3, pending: 3, syncing: 0, failed: 0 };
const SYNCING_COUNTS: QueueCounts = { total: 2, pending: 1, syncing: 1, failed: 0 };

const meta: Meta<typeof SyncPill> = {
  title: 'Components/SyncPill',
  component: SyncPill,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Header pending-sync indicator. It appears whenever the offline write queue has ' +
          'entries (pending / syncing / failed). When there are writes that exhausted their ' +
          'automatic retries, the pill turns red and becomes clickable, opening a dialog that ' +
          'lists each failed change with its error plus one-tap Retry and Discard actions, ' +
          'as well as bulk Retry all / Discard all (confirmation-gated) / Download as PDF actions.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof SyncPill>;

/** Interactive failed state: retry/discard remove from the local list to demo the flow. */
function InteractiveFailed({ open }: { open?: boolean }) {
  const [failures, setFailures] = useState<QueueEntry[]>(SAMPLE_FAILURES);
  const remove = (id: number) => setFailures((fs) => fs.filter((f) => f.id !== id));
  const clearAll = () => setFailures([]);
  return (
    <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
      <SyncPill
        counts={{ total: failures.length, pending: 0, syncing: 0, failed: failures.length }}
        failures={failures}
        defaultOpen={open}
        onRetry={remove}
        onDiscard={remove}
        onRetryAll={clearAll}
        onDiscardAll={clearAll}
      />
    </Box>
  );
}

export const FailedPill: Story = {
  name: 'Failed (pill, closed)',
  render: () => <InteractiveFailed />,
};

export const FailedDialog: Story = {
  name: 'Failed (retry dialog open)',
  render: () => <InteractiveFailed open />,
};

export const Pending: Story = {
  name: 'Pending',
  render: () => (
    <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
      <SyncPill counts={PENDING_COUNTS} failures={[]} />
    </Box>
  ),
};

export const Syncing: Story = {
  name: 'Syncing',
  render: () => (
    <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
      <SyncPill counts={SYNCING_COUNTS} failures={[]} />
    </Box>
  ),
};

export const VariedReasons: Story = {
  name: 'Failed (plain-language reasons)',
  render: () => {
    function Many() {
      const [failures, setFailures] = useState<QueueEntry[]>(VARIED_FAILURES);
      const remove = (id: number) => setFailures((fs) => fs.filter((f) => f.id !== id));
      const clearAll = () => setFailures([]);
      return (
        <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
          <SyncPill
            counts={{ total: failures.length, pending: 0, syncing: 0, failed: failures.length }}
            failures={failures}
            defaultOpen
            onRetry={remove}
            onDiscard={remove}
            onRetryAll={clearAll}
            onDiscardAll={clearAll}
          />
        </Box>
      );
    }
    return <Many />;
  },
};

export const SingleFailure: Story = {
  name: 'Single failure',
  render: () => {
    function One() {
      const [failures, setFailures] = useState<QueueEntry[]>([SAMPLE_FAILURES[0]]);
      const remove = (id: number) => setFailures((fs) => fs.filter((f) => f.id !== id));
      return (
        <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
          <SyncPill
            counts={{ total: failures.length, pending: 0, syncing: 0, failed: failures.length }}
            failures={failures}
            defaultOpen
            onRetry={remove}
            onDiscard={remove}
          />
        </Box>
      );
    }
    return <One />;
  },
};
