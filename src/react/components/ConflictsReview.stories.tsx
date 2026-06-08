import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import { useState } from 'react';
import ConflictsReview from './ConflictsReview';
import type { ConflictEntry } from '../lib/offlineQueue';

const now = Date.now();

const SAMPLE: ConflictEntry[] = [
  {
    id: 1,
    area: 'visit',
    label: 'Design visit — 14 Oak Lane',
    url: '/api/design-visits/482',
    method: 'PUT',
    recordKey: 'dv:482',
    baseVersion: 3,
    serverVersion: 5,
    baseUpdatedAt: new Date(now - 1000 * 60 * 60 * 6).toISOString(),
    serverUpdatedAt: new Date(now - 1000 * 60 * 30).toISOString(),
    resolution: 'last_write_wins',
    detectedAt: now - 1000 * 60 * 12,
  },
  {
    id: 2,
    area: 'customer',
    label: 'Lead status — Priya Sharma',
    url: '/api/contacts/991/lead-status',
    method: 'PATCH',
    recordKey: 'contact:991',
    baseUpdatedAt: new Date(now - 1000 * 60 * 60 * 2).toISOString(),
    serverUpdatedAt: new Date(now - 1000 * 60 * 5).toISOString(),
    resolution: 'last_write_wins',
    detectedAt: now - 1000 * 60 * 3,
  },
];

const meta: Meta<typeof ConflictsReview> = {
  title: 'Components/ConflictsReview',
  component: ConflictsReview,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Header pill + dialog that lists offline sync conflicts (Offline Phase 3). ' +
          'A conflict is persisted when a queued offline edit replays onto a record that ' +
          'changed on the server: the edit is applied (last-write-wins) and the overwritten ' +
          'server copy is recorded for review. The pill appears only while unreviewed ' +
          'conflicts exist; users dismiss each (or all) to clear them from the IndexedDB store.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof ConflictsReview>;

/** Interactive: dismiss removes from the local list so the flow is demonstrable. */
function Interactive({ open }: { open?: boolean }) {
  const [conflicts, setConflicts] = useState<ConflictEntry[]>(SAMPLE);
  return (
    <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
      <ConflictsReview
        conflicts={conflicts}
        defaultOpen={open}
        onDismiss={(id) => setConflicts((cs) => cs.filter((c) => c.id !== id))}
        onDismissAll={() => setConflicts([])}
      />
    </Box>
  );
}

export const Pill: Story = {
  name: 'Header pill (closed)',
  render: () => <Interactive />,
};

export const DialogOpen: Story = {
  name: 'Review dialog (open)',
  render: () => <Interactive open />,
};

export const SingleConflict: Story = {
  name: 'Single conflict',
  render: () => {
    function One() {
      const [conflicts, setConflicts] = useState<ConflictEntry[]>([SAMPLE[0]]);
      return (
        <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
          <ConflictsReview
            conflicts={conflicts}
            defaultOpen
            onDismiss={(id) => setConflicts((cs) => cs.filter((c) => c.id !== id))}
            onDismissAll={() => setConflicts([])}
          />
        </Box>
      );
    }
    return <One />;
  },
};
