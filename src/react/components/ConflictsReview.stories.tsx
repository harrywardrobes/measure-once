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
    // Field-level diff inputs: the queued edit vs the server snapshot. The
    // server arrives wrapped in a `designVisit` envelope, which buildFieldDiff
    // unwraps before comparing. The top-level `contact_id` lets
    // resolveConflictRoute derive the owning customer page for the "Open record"
    // link without appearing as a field-diff row.
    attemptedBody: {
      leadStatus: 'won',
      notes: 'Customer ready to proceed with the kitchen.',
      appointmentDate: '2026-06-12',
      estimateTotal: 8200,
      // Write shape: camelCase, door style by id. Three rooms exercise the
      // per-room toggle states: Room 1 (Kitchen) changed (units + price), Room 2
      // (Bedroom) unchanged, Room 3 (Utility) added in this edit (absent on the
      // server). Each changed/added room gets its own keep-mine / use-server
      // toggle so the field user can mix per-room choices.
      rooms: [
        { roomName: 'Kitchen', doorStyleId: 3, widthMm: 3200, heightMm: 2400, depthMm: 600, unitCount: 12, unitPricePence: 145000 },
        { roomName: 'Bedroom', doorStyleId: 7, widthMm: 4000, heightMm: 2400, depthMm: 600, unitCount: 8, unitPricePence: 98000 },
        { roomName: 'Utility', doorStyleId: 3, widthMm: 1800, heightMm: 2400, depthMm: 600, unitCount: 5, unitPricePence: 62000 },
      ],
    },
    serverData: {
      contact_id: '4071',
      designVisit: {
        version: 5,
        updated_at: new Date(now - 1000 * 60 * 30).toISOString(),
        leadStatus: 'in_progress',
        notes: 'Customer ready to proceed with the kitchen.',
        appointmentDate: '2026-06-10',
        estimateTotal: 7500,
        // Read shape: snake_case, door style carries both id and resolved name.
        rooms: [
          { room_name: 'Kitchen', door_style_id: 3, door_style_name: 'Shaker White', width_mm: 3200, height_mm: 2400, depth_mm: 600, unit_count: 10, unit_price_pence: 139000 },
          { room_name: 'Bedroom', door_style_id: 7, door_style_name: 'Oak Veneer', width_mm: 4000, height_mm: 2400, depth_mm: 600, unit_count: 8, unit_price_pence: 98000 },
        ],
      },
    },
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
    attemptedBody: { leadStatus: 'qualified' },
    serverData: { leadStatus: 'unqualified' },
    resolution: 'flagged',
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
          'conflicts exist. Each conflict can be resolved by keeping your edit, restoring the ' +
          'server copy, or picking per field which value to keep — restoring replays a write ' +
          'with the chosen server values, then clears the conflict.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof ConflictsReview>;

/**
 * Interactive: resolving (keep my edit / restore server copy / per-field) removes
 * the conflict from the local list so the full flow is demonstrable. The real
 * `onResolve` replays a write and clears the conflict; here we just drop it.
 */
function Interactive({ open }: { open?: boolean }) {
  const [conflicts, setConflicts] = useState<ConflictEntry[]>(SAMPLE);
  return (
    <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
      <ConflictsReview
        conflicts={conflicts}
        defaultOpen={open}
        onResolve={async (conflict) => {
          setConflicts((cs) => cs.filter((c) => c.id !== conflict.id));
          return { ok: true, queued: false, status: 200 };
        }}
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

/**
 * The server advanced *again* between conflict detection and the user clicking
 * "Restore server copy". The restore is abandoned (nothing is overwritten) and a
 * dialog-level notice explains why, while a refreshed conflict stays in the list.
 */
export const ReconflictOnRestore: Story = {
  name: 'Restore re-flagged (server changed again)',
  render: () => {
    function Reconflict() {
      const [conflicts] = useState<ConflictEntry[]>([SAMPLE[0]]);
      return (
        <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
          <ConflictsReview
            conflicts={conflicts}
            defaultOpen
            onResolve={async (_conflict, body) => {
              // A restore (body !== null) finds the server has moved on again.
              if (body !== null) return { ok: false, queued: false, status: 0, reconflicted: true };
              return { ok: true, queued: false, status: 200 };
            }}
          />
        </Box>
      );
    }
    return <Reconflict />;
  },
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
            onResolve={async (conflict) => {
              setConflicts((cs) => cs.filter((c) => c.id !== conflict.id));
              return { ok: true, queued: false, status: 200 };
            }}
            onDismissAll={() => setConflicts([])}
          />
        </Box>
      );
    }
    return <One />;
  },
};

/**
 * A contact record with five changed non-rooms fields exercises the new bulk
 * field shortcuts. Expand "Compare fields (5 changed)" to see the compact
 * "Keep all mine / Use server for all fields" bar above the table.
 * Clicking "Use server for all fields" flips every field to the server side and
 * enables the "Apply selection (5)" button; individual per-field toggles still
 * override the bulk choice afterwards.
 */
export const BulkFieldShortcuts: Story = {
  name: 'Bulk field shortcuts (Use server for all fields / Keep all mine)',
  render: () => {
    const multiFieldConflict: ConflictEntry = {
      id: 10,
      area: 'customer',
      label: 'Contact details — James Okafor',
      url: '/api/contacts/1200',
      method: 'PUT',
      recordKey: 'contact:1200',
      baseUpdatedAt: new Date(now - 1000 * 60 * 60 * 3).toISOString(),
      serverUpdatedAt: new Date(now - 1000 * 60 * 15).toISOString(),
      attemptedBody: {
        firstName: 'James',
        lastName: 'Okafor',
        email: 'james.okafor@example.com',
        phone: '07700900123',
        address: '18 Maple Street',
        city: 'Leeds',
        postcode: 'LS1 1AB',
      },
      serverData: {
        firstName: 'Jim',
        lastName: 'Okafor-Smith',
        email: 'jim.okafor@example.org',
        phone: '07700900456',
        address: '18 Maple Street',
        city: 'Manchester',
        postcode: 'M1 1AE',
      },
      resolution: 'last_write_wins',
      detectedAt: now - 1000 * 60 * 8,
    };
    function Bulk() {
      const [conflicts, setConflicts] = useState<ConflictEntry[]>([multiFieldConflict]);
      return (
        <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
          <ConflictsReview
            conflicts={conflicts}
            defaultOpen
            onResolve={async (conflict) => {
              setConflicts((cs) => cs.filter((c) => c.id !== conflict.id));
              return { ok: true, queued: false, status: 200 };
            }}
            onDismissAll={() => setConflicts([])}
          />
        </Box>
      );
    }
    return <Bulk />;
  },
};

/**
 * Multi-room conflict with the bulk shortcuts visible: expand "Compare fields"
 * to see the "Use server for all" / "Keep all mine" header above the per-room
 * toggles. The fixture has three rooms — Kitchen (changed), Bedroom (unchanged),
 * and Utility (added by the edit) — so the bulk bar reads "2 rooms changed".
 * Clicking "Use server for all" flips all changed rooms to the server side at
 * once; each per-room toggle can still override afterwards.
 */
export const BulkRoomShortcuts: Story = {
  name: 'Bulk room shortcuts (Use server for all / Keep all mine)',
  render: () => {
    function Bulk() {
      const [conflicts, setConflicts] = useState<ConflictEntry[]>([SAMPLE[0]]);
      return (
        <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
          <ConflictsReview
            conflicts={conflicts}
            defaultOpen
            onResolve={async (conflict) => {
              setConflicts((cs) => cs.filter((c) => c.id !== conflict.id));
              return { ok: true, queued: false, status: 200 };
            }}
            onDismissAll={() => setConflicts([])}
          />
        </Box>
      );
    }
    return <Bulk />;
  },
};

/**
 * Per-room resolution: the queued edit *removed* a room the server still has
 * (Room 2, Bedroom — present only on the server). Its per-room toggle reads
 * "Keep mine" (stay removed) vs "Restore room" (bring the server's room back),
 * letting the field user decide that one room independently of the others.
 */
export const RemovedRoom: Story = {
  name: 'Per-room: removed room (restore individually)',
  render: () => {
    function Removed() {
      const removedRoomConflict: ConflictEntry = {
        ...SAMPLE[0],
        id: 3,
        label: 'Design visit — 9 Birch Court',
        attemptedBody: {
          ...(SAMPLE[0].attemptedBody as Record<string, unknown>),
          // User kept only the Kitchen — the Bedroom they dropped still exists on
          // the server, so it reads as "Only on server" and can be restored.
          rooms: [
            { roomName: 'Kitchen', doorStyleId: 3, widthMm: 3200, heightMm: 2400, depthMm: 600, unitCount: 12, unitPricePence: 145000 },
          ],
        },
        serverData: {
          contact_id: '4071',
          designVisit: {
            version: 5,
            updated_at: new Date(now - 1000 * 60 * 30).toISOString(),
            leadStatus: 'in_progress',
            notes: 'Customer ready to proceed with the kitchen.',
            appointmentDate: '2026-06-10',
            estimateTotal: 7500,
            rooms: [
              { room_name: 'Kitchen', door_style_id: 3, door_style_name: 'Shaker White', width_mm: 3200, height_mm: 2400, depth_mm: 600, unit_count: 10, unit_price_pence: 139000 },
              { room_name: 'Bedroom', door_style_id: 7, door_style_name: 'Oak Veneer', width_mm: 4000, height_mm: 2400, depth_mm: 600, unit_count: 8, unit_price_pence: 98000 },
            ],
          },
        },
      };
      const [conflicts, setConflicts] = useState<ConflictEntry[]>([removedRoomConflict]);
      return (
        <Box sx={{ p: 4, bgcolor: '#200842', borderRadius: 2 }}>
          <ConflictsReview
            conflicts={conflicts}
            defaultOpen
            onResolve={async (conflict) => {
              setConflicts((cs) => cs.filter((c) => c.id !== conflict.id));
              return { ok: true, queued: false, status: 200 };
            }}
            onDismissAll={() => setConflicts([])}
          />
        </Box>
      );
    }
    return <Removed />;
  },
};
