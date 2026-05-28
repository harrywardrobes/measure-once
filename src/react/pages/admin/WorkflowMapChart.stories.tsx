import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { WorkflowMapChart, type WorkflowMapNodeData } from '../../components/WorkflowMapChart';
import { WorkflowMapDetailPanel } from '../../components/WorkflowMapDetailPanel';

const meta: Meta<typeof WorkflowMapChart> = {
  title: 'Features/CardActions/WorkflowMapChart',
  component: WorkflowMapChart,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Interactive ReactFlow flowchart showing the full stage → lead status → sub-status ' +
          'hierarchy for the Card Actions admin tab. Nodes are clickable to open a detail drawer. ' +
          'Re-fetches and re-renders when BroadcastChannel fires lead_statuses_changed or ' +
          'card_action_handlers_changed.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof WorkflowMapChart>;

// ── Fixture data ───────────────────────────────────────────────────────────────

const LABELS = [
  { stage_key: 'sales',       status_key: 'form_submission',   label: 'Review enquiry' },
  { stage_key: 'sales',       status_key: 'in_progress',       label: 'Send quote' },
  { stage_key: 'designvisit', status_key: 'scheduled',         label: 'Confirm visit' },
  { stage_key: 'survey',      status_key: 'design_accepted',   label: 'Accept design' },
];

const STATUSES = [
  { key: 'FORM_SUBMISSION',   label: 'Form submission',      stage: 'SALES',        shorthand: 'FS', sort_order: 0, excluded_from_sales: false, is_null_row: false },
  { key: 'ATTEMPTED_CONTACT', label: 'Attempted to contact', stage: 'SALES',        shorthand: 'AC', sort_order: 1, excluded_from_sales: false, is_null_row: false },
  { key: 'IN_PROGRESS',       label: 'In progress',          stage: 'SALES',        shorthand: 'IP', sort_order: 2, excluded_from_sales: false, is_null_row: false },
  { key: 'AWAITING_PHOTOS',   label: 'Awaiting photos',      stage: 'SALES',        shorthand: 'AP', sort_order: 3, excluded_from_sales: false, is_null_row: false },
  { key: 'SCHEDULED',         label: 'Scheduled',            stage: 'DESIGN_VISIT', shorthand: 'DS', sort_order: 0, excluded_from_sales: false, is_null_row: false },
  { key: 'OPEN_DEAL',         label: 'Open deal',            stage: 'DESIGN_VISIT', shorthand: 'OD', sort_order: 1, excluded_from_sales: false, is_null_row: false },
  { key: 'DESIGN_ACCEPTED',   label: 'Design accepted',      stage: 'SURVEY',       shorthand: 'DA', sort_order: 0, excluded_from_sales: false, is_null_row: false },
  { key: 'AWAITING_DEPOSIT',  label: 'Awaiting deposit',     stage: 'SURVEY',       shorthand: 'AD', sort_order: 1, excluded_from_sales: false, is_null_row: false },
];

const SUBSTATUSES = [
  { id: 1, status_key: 'IN_PROGRESS', substatus_key: 'IP_HOT_LEAD',     label: 'Hot lead',     action_label: 'Mark hot',      sort_order: 0, default_handler_type: 'summarise_phone_call' },
  { id: 2, status_key: 'IN_PROGRESS', substatus_key: 'IP_COLD_LEAD',    label: 'Cold lead',    action_label: 'Mark cold',     sort_order: 1, default_handler_type: '' },
  { id: 3, status_key: 'SCHEDULED',   substatus_key: 'DS_CONFIRMED',    label: 'Confirmed',    action_label: 'Mark confirmed', sort_order: 0, default_handler_type: 'start_design_visit' },
  { id: 4, status_key: 'SCHEDULED',   substatus_key: 'DS_UNCONFIRMED',  label: 'Unconfirmed',  action_label: 'Chase',         sort_order: 1, default_handler_type: '' },
];

const HANDLERS_WITH_BINDINGS = [
  {
    id: 1,
    name: 'Summarise call',
    type: 'summarise_phone_call',
    config: { action_name: 'Summarise call', notes_property: 'hs_call_body' },
    bindings: [{ substatus_id: 1 }],
  },
  {
    id: 2,
    name: 'Start design visit',
    type: 'start_design_visit',
    config: { action_name: 'Start design visit', submitted_lead_status: 'DS_CONFIRMED' },
    bindings: [{ substatus_id: 3 }],
  },
  {
    id: 3,
    name: 'Add to calendar',
    type: 'add_design_visit_to_calendar',
    config: { action_name: 'Add to calendar' },
    bindings: [{ stage_key: 'designvisit', status_key: 'scheduled' }],
  },
];

// ── Stories ────────────────────────────────────────────────────────────────────

function ChartWrapper(props: React.ComponentProps<typeof WorkflowMapChart>) {
  const [selected, setSelected] = useState<WorkflowMapNodeData | null>(null);
  return (
    <Box sx={{ position: 'relative', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <WorkflowMapChart {...props} onNodeClick={setSelected} />
      </Box>
      <WorkflowMapDetailPanel node={selected} onClose={() => setSelected(null)} />
    </Box>
  );
}

export const MultiStageWithHandlers: Story = {
  name: 'Multi-stage with handlers',
  render: () => (
    <ChartWrapper
      labels={LABELS}
      statuses={STATUSES}
      substatuses={SUBSTATUSES}
      handlers={HANDLERS_WITH_BINDINGS}
      onNodeClick={() => {}}
    />
  ),
};

export const SubstatusNoHandler: Story = {
  name: 'Sub-status with no handler',
  render: () => (
    <ChartWrapper
      labels={LABELS}
      statuses={STATUSES}
      substatuses={[
        { id: 10, status_key: 'IN_PROGRESS', substatus_key: 'IP_NO_HANDLER', label: 'No handler bound', action_label: 'Do action', sort_order: 0 },
      ]}
      handlers={[]}
      onNodeClick={() => {}}
    />
  ),
};

export const EmptyOrLoading: Story = {
  name: 'Empty / loading state',
  render: () => (
    <Box sx={{ p: 4 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        When no statuses are configured the chart renders an empty ReactFlow canvas.
      </Typography>
      <Box sx={{ height: 300, border: '1px solid #e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
        <ChartWrapper
          labels={[]}
          statuses={[]}
          substatuses={[]}
          handlers={[]}
          onNodeClick={() => {}}
        />
      </Box>
    </Box>
  ),
};
