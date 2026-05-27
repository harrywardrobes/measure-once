import React, { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { StagePicker } from './StagePicker';
import { LeadStatusPicker } from './LeadStatusPicker';
import { SubstagePicker } from './SubstagePicker';

const meta: Meta = {
  title: 'Components/Pickers',
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

function StagePickerDemo() {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [current, setCurrent] = useState('sales');

  const STAGE_LABELS: Record<string, string> = {
    sales: 'Sales', designvisit: 'Design Visit', survey: 'Survey', order: 'Order',
    workshop: 'Workshop', packing: 'Packing', delivery: 'Delivery',
    installation: 'Installation', aftercare: 'Aftercare', customerservice: 'Customer Service',
  };

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Current stage: <strong>{STAGE_LABELS[current] || current}</strong>
      </Typography>
      <Button variant="outlined" onClick={(e) => setAnchorEl(e.currentTarget)}>
        Change Stage
      </Button>
      <StagePicker
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        currentStageKey={current}
        onSelect={(key) => { setCurrent(key); setAnchorEl(null); }}
      />
    </Box>
  );
}

export const StagePickerStory: Story = {
  name: 'StagePicker',
  render: () => <StagePickerDemo />,
};

const MOCK_LEAD_STATUSES = [
  { value: 'NEW_LEAD',         label: 'New Lead' },
  { value: 'CONTACTED',        label: 'Contacted' },
  { value: 'QUALIFIED',        label: 'Qualified' },
  { value: 'PROPOSAL_SENT',    label: 'Proposal Sent' },
  { value: 'FOLLOW_UP',        label: 'Follow-up' },
  { value: 'CLOSED_WON',       label: 'Closed Won' },
  { value: 'CLOSED_LOST',      label: 'Closed Lost' },
];

const MOCK_SUBSTATUSES = [
  { status_key: 'NEW_LEAD', substatus_key: 'WEBSITE', label: 'Website enquiry', sort_order: 1 },
  { status_key: 'NEW_LEAD', substatus_key: 'REFERRAL', label: 'Referral', sort_order: 2 },
  { status_key: 'CONTACTED', substatus_key: 'LEFT_VOICEMAIL', label: 'Left voicemail', sort_order: 1 },
  { status_key: 'CONTACTED', substatus_key: 'EMAIL_SENT', label: 'Email sent', sort_order: 2 },
];

function patchWindowGlobals() {
  (window as unknown as Record<string, unknown>).LEAD_STATUS_OPTIONS = MOCK_LEAD_STATUSES;
  (window as unknown as Record<string, unknown>).LEAD_SUBSTATUSES = MOCK_SUBSTATUSES;
  (window as unknown as Record<string, unknown>).quickSetLeadStatus = (contactId: string, status: string) => {
    console.log('[story] quickSetLeadStatus', { contactId, status });
  };
  (window as unknown as Record<string, unknown>)._quickSetLeadStatusWithSub = (contactId: string, statusKey: string, subKey: string) => {
    console.log('[story] _quickSetLeadStatusWithSub', { contactId, statusKey, subKey });
  };
  (window as unknown as Record<string, unknown>).showToast = (msg: string) => {
    console.log('[story] toast:', msg);
  };
}

function LeadStatusPickerDemo({ showSubstatuses }: { showSubstatuses?: boolean }) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [current, setCurrent] = useState('NEW_LEAD');

  React.useEffect(() => { patchWindowGlobals(); }, []);

  (window as unknown as Record<string, unknown>).quickSetLeadStatus = (_: string, status: string) => {
    setCurrent(status || '—');
    setAnchorEl(null);
  };

  const label = MOCK_LEAD_STATUSES.find((s) => s.value === current)?.label || current || '(none)';

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Current lead status: <strong>{label}</strong>
      </Typography>
      <Button variant="outlined" onClick={(e) => setAnchorEl(e.currentTarget)}>
        Change Status
      </Button>
      <LeadStatusPicker
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        contactId="demo-contact-123"
        currentStatus={current}
        currentHwSubstatus=""
        showSubstatuses={showSubstatuses}
      />
    </Box>
  );
}

export const LeadStatusPickerStory: Story = {
  name: 'LeadStatusPicker',
  render: () => <LeadStatusPickerDemo />,
};

export const LeadStatusPickerWithSubstatuses: Story = {
  name: 'LeadStatusPicker — with sub-statuses',
  render: () => <LeadStatusPickerDemo showSubstatuses />,
};

const MOCK_STATUSES = [
  { id: 'measuring', label: 'Measuring' },
  { id: 'awaiting_plans', label: 'Awaiting plans' },
  { id: 'plans_received', label: 'Plans received' },
  { id: 'on_hold', label: 'On hold' },
  { id: 'complete', label: 'Complete' },
];

function SubstagePickerDemo() {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [currentSubId, setCurrentSubId] = useState('measuring');

  const label = MOCK_STATUSES.find((s) => s.id === currentSubId)?.label || currentSubId;

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Current substage: <strong>{label}</strong>
      </Typography>
      <Button variant="outlined" onClick={(e) => setAnchorEl(e.currentTarget)}>
        Change Substage
      </Button>
      <SubstagePicker
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        contactId="demo-contact-123"
        roomIdx={0}
        stageKey="survey"
        statuses={MOCK_STATUSES}
        currentSubId={currentSubId}
      />
    </Box>
  );
}

export const SubstagePickerStory: Story = {
  name: 'SubstagePicker',
  render: () => <SubstagePickerDemo />,
};
