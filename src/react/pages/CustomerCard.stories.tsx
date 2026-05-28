import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Box, Card, CardActionArea, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

const DEFAULT_STAGE_COLOURS: Record<string, { bg: string; light: string; text: string }> = {
  sales:        { bg: '#8B2BFF', light: '#F3EAFF', text: '#6A12D9' },
  designvisit:  { bg: '#0d9488', light: '#ccfbf1', text: '#0f766e' },
  survey:       { bg: '#d97706', light: '#fef3c7', text: '#b45309' },
  order:        { bg: '#2563eb', light: '#dbeafe', text: '#1d4ed8' },
  workshop:     { bg: '#dc2626', light: '#fee2e2', text: '#b91c1c' },
  packing:      { bg: '#059669', light: '#d1fae5', text: '#047857' },
  delivery:     { bg: '#0891b2', light: '#cffafe', text: '#0e7490' },
  installation: { bg: '#8A5A3B', light: '#fdf6ee', text: '#5c3820' },
  aftercare:    { bg: '#200842', light: '#ede0ff', text: '#3d0f7a' },
};

const DEFAULT_STAGE_LABELS: Record<string, string> = {
  sales: 'Sales',
  designvisit: 'Design Visit',
  survey: 'Survey',
  order: 'Order',
  workshop: 'Workshop',
  packing: 'Packing',
  delivery: 'Delivery',
  installation: 'Installation',
  aftercare: 'Aftercare',
};

const meta: Meta = {
  title: 'Features/Pages/CustomerCard',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The **CustomerCard** component shown on the Customers page. Cards display contact details, pipeline stage pills, and invoice/customer-number chips. When a card action handler is configured for the contact\'s primary stage/lead-status, an **action strip** appears at the bottom — tinted with the stage colour. Clicking the strip opens the handler modal; clicking the rest of the card navigates to the customer detail page.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

// ── Shared demo card shell ──────────────────────────────────────────────────

interface DemoRoom {
  stageKey: string;
  roomLabel: string;
}

interface DemoCustomerCardProps {
  name: string;
  email?: string;
  phone?: string;
  leadStatusLabel?: string;
  customerNumber?: string;
  rooms: DemoRoom[];
  actionLabel?: string;
  showInvoiceBadge?: boolean;
}

function StagePill({ stageKey, label }: { stageKey: string; label: string }) {
  const sc = DEFAULT_STAGE_COLOURS[stageKey] || DEFAULT_STAGE_COLOURS.sales;
  return (
    <Box
      component="span"
      sx={{
        fontSize: '0.72rem',
        fontWeight: 700,
        px: '8px',
        py: '2px',
        borderRadius: '999px',
        background: sc.light,
        color: sc.text,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  );
}

function DemoCustomerCard({
  name,
  email,
  phone,
  leadStatusLabel,
  customerNumber,
  rooms,
  actionLabel,
  showInvoiceBadge = false,
}: DemoCustomerCardProps) {
  const primaryStageKey = rooms[0]?.stageKey || 'sales';
  const sc = DEFAULT_STAGE_COLOURS[primaryStageKey] || DEFAULT_STAGE_COLOURS.sales;
  const [dispatching, setDispatching] = useState(false);

  const handleActionClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dispatching) return;
    setDispatching(true);
    setTimeout(() => setDispatching(false), 1200);
  };

  return (
    <Card variant="outlined" sx={{ width: '100%', maxWidth: 340 }}>
      <CardActionArea
        component="a"
        href="#"
        onClick={(e) => e.preventDefault()}
        sx={{ p: 2, display: 'block' }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Typography variant="subtitle1" noWrap sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name}
          </Typography>
          {leadStatusLabel ? (
            <Chip label={leadStatusLabel} size="small" color="primary" variant="outlined" />
          ) : null}
        </Stack>

        <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap' }}>
          {rooms.map((r, i) => (
            <StagePill key={i} stageKey={r.stageKey} label={r.roomLabel || DEFAULT_STAGE_LABELS[r.stageKey] || r.stageKey} />
          ))}
        </Stack>

        <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }}>
          {email ? <Chip label={email} size="small" variant="outlined" /> : null}
          {phone ? <Chip label={phone} size="small" variant="outlined" /> : null}
          {showInvoiceBadge ? (
            <Chip label="1 invoice" size="small" color="success" variant="outlined" />
          ) : null}
          {customerNumber ? (
            <Chip label={customerNumber} size="small" color="secondary" variant="outlined" />
          ) : null}
        </Stack>
      </CardActionArea>

      {actionLabel ? (
        <Box
          role="button"
          tabIndex={0}
          aria-label={actionLabel}
          onClick={handleActionClick}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: '14px',
            py: '9px',
            bgcolor: sc.light,
            borderTop: '1px solid',
            borderColor: 'divider',
            cursor: dispatching ? 'wait' : 'pointer',
            opacity: dispatching ? 0.7 : 1,
            transition: 'opacity 0.15s, filter 0.12s',
            '&:hover': dispatching ? undefined : { filter: 'brightness(0.96)' },
            '&:focus-visible': { outline: `2px solid ${sc.bg}`, outlineOffset: -2 },
          }}
        >
          <Typography sx={{ color: sc.text, fontWeight: 600, fontSize: '0.78rem' }}>
            {dispatching ? 'Opening…' : actionLabel}
          </Typography>
          {dispatching ? (
            <CircularProgress size={12} sx={{ color: sc.text }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 15, color: sc.text, flexShrink: 0 }} />
          )}
        </Box>
      ) : null}
    </Card>
  );
}

// ── Stories ─────────────────────────────────────────────────────────────────

export const NoActionStrip: Story = {
  name: 'No action strip',
  parameters: {
    docs: {
      description: {
        story: 'A standard customer card with no handler configured for this stage. The card navigates to the customer detail page on click.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Sarah Johnson"
      email="sarah@example.com"
      phone="07700 900 123"
      leadStatusLabel="Qualified"
      rooms={[{ stageKey: 'sales', roomLabel: 'Sales' }]}
    />
  ),
};

export const WithActionStrip: Story = {
  name: 'With action strip — Book design visit',
  parameters: {
    docs: {
      description: {
        story: 'Card with a handler configured for the Sales stage. The tinted strip at the bottom opens the action modal; clicking the rest of the card still navigates.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="James Carter"
      email="james@example.com"
      phone="07700 900 456"
      leadStatusLabel="New Lead"
      rooms={[{ stageKey: 'sales', roomLabel: 'Sales' }]}
      actionLabel="Book Design Visit"
    />
  ),
};

export const DesignVisitStage: Story = {
  name: 'Action strip — Design Visit stage',
  parameters: {
    docs: {
      description: {
        story: 'The Design Visit stage colour (teal) tints the action strip.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Emily Walsh"
      email="emily@example.com"
      rooms={[{ stageKey: 'designvisit', roomLabel: 'Design Visit' }]}
      actionLabel="Start Design Visit"
    />
  ),
};

export const SurveyStage: Story = {
  name: 'Action strip — Survey stage',
  parameters: {
    docs: {
      description: {
        story: 'The Survey stage colour (amber) tints the action strip.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Tom Richards"
      email="tom@example.com"
      rooms={[{ stageKey: 'survey', roomLabel: 'Survey' }]}
      actionLabel="Schedule Survey"
    />
  ),
};

export const InstallationStage: Story = {
  name: 'Action strip — Installation stage',
  parameters: {
    docs: {
      description: {
        story: 'The Installation stage colour (brown) tints the action strip.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Priya Patel"
      email="priya@example.com"
      rooms={[{ stageKey: 'installation', roomLabel: 'Installation' }]}
      actionLabel="Schedule Installation"
    />
  ),
};

export const MultiRoom: Story = {
  name: 'Multi-room — primary stage drives strip',
  parameters: {
    docs: {
      description: {
        story: 'When a contact has multiple rooms at different stages, the **first** room\'s stage key drives the action strip colour and handler. All room stage pills are shown.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Olivia Grant"
      email="olivia@example.com"
      customerNumber="C-1042"
      rooms={[
        { stageKey: 'order', roomLabel: 'Kitchen — Order' },
        { stageKey: 'workshop', roomLabel: 'Utility — Workshop' },
      ]}
      actionLabel="Send Order Confirmation"
    />
  ),
};

export const WithInvoiceBadge: Story = {
  name: 'With invoice badge + action strip',
  parameters: {
    docs: {
      description: {
        story: 'Invoice badge and action strip can both appear simultaneously.',
      },
    },
  },
  render: () => (
    <DemoCustomerCard
      name="Daniel Kim"
      email="daniel@example.com"
      leadStatusLabel="Won"
      customerNumber="C-0887"
      rooms={[{ stageKey: 'delivery', roomLabel: 'Delivery' }]}
      actionLabel="Confirm Delivery"
      showInvoiceBadge
    />
  ),
};

export const AllStageVariants: Story = {
  name: 'All stage colour variants',
  parameters: {
    docs: {
      description: {
        story: 'One card per pipeline stage, showing each stage colour tinting the action strip.',
      },
    },
  },
  render: () => (
    <Stack spacing={2} sx={{ maxWidth: 360 }}>
      {Object.entries(DEFAULT_STAGE_LABELS).map(([stageKey, stageLabel]) => (
        <DemoCustomerCard
          key={stageKey}
          name={`Demo Customer — ${stageLabel}`}
          email="demo@example.com"
          rooms={[{ stageKey, roomLabel: stageLabel }]}
          actionLabel={`Action for ${stageLabel}`}
        />
      ))}
    </Stack>
  ),
};
