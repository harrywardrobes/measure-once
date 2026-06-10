import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Box, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CircularProgress from '@mui/material/CircularProgress';
import { BRAND_COLORS, STAGE_COLORS, STATUS_COLORS } from '../theme';
import { UrgencyDot } from '../components/UrgencyDot';
import type { Urgency } from '../components/UrgencyDot';

const meta: Meta = {
  title: 'Features/Pages/ProjectCard',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The **ProjectCard** component shown on the Projects page. Cards display a contact\'s rooms across pipeline stages. When a card action handler is configured for the card\'s stage/lead-status, an **action strip** appears at the bottom. A **"Continue designing"** strip appears when the contact has a saved draft design visit.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

// ── Shared demo card shell ──────────────────────────────────────────────────

interface DemoRoom {
  roomLabel: string;
  stageKey: string;
  fitterName?: string;
}

interface DemoCardProps {
  name: string;
  contactId?: string;
  installLabel?: string;
  rooms: DemoRoom[];
  actionLabel?: string;
  actionStageKey?: string;
  showContinueDesigning?: boolean;
  continuingDesign?: boolean;
  photosReceived?: boolean;
  /** When true, the strip is label-only (no handler) — non-interactive, no chevron. */
  labelOnly?: boolean;
  urgency?: Urgency;
}

function DemoProjectCard({
  name,
  contactId = '12345',
  installLabel,
  rooms,
  actionLabel,
  actionStageKey,
  showContinueDesigning = false,
  continuingDesign = false,
  photosReceived = false,
  labelOnly = false,
  urgency = null,
}: DemoCardProps) {
  const stageColors = STAGE_COLORS[actionStageKey || rooms[0]?.stageKey || ''];
  const actionTint = stageColors?.light || STATUS_COLORS.neutral.bg;
  const actionTextColor = stageColors?.text || STATUS_COLORS.neutral.text;
  const isInteractive = !labelOnly;

  return (
    <Box
      sx={{
        background: BRAND_COLORS.paper,
        border: `1px solid ${BRAND_COLORS.stone}`,
        borderRadius: '12px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        overflow: 'hidden',
        maxWidth: 340,
      }}
    >
      {/* Card header */}
      <Box sx={{ p: '12px 14px 10px', borderBottom: `1px solid ${BRAND_COLORS.stone}` }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <UrgencyDot urgency={urgency} />
          <Typography
            sx={{
              fontSize: '0.975rem',
              fontWeight: 700,
              color: BRAND_COLORS.ink1,
              lineHeight: 1.25,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name}
          </Typography>
          {installLabel && (
            <Typography
              sx={{
                fontSize: '0.68rem',
                fontWeight: 600,
                color: BRAND_COLORS.ink3,
                whiteSpace: 'nowrap',
              }}
            >
              Install: {installLabel}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: '2px', flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: '0.72rem', fontWeight: 500, color: BRAND_COLORS.ink4, letterSpacing: '0.02em' }}>
            #{contactId}
          </Typography>
          {photosReceived && (
            <Box
              component="span"
              title="Customer has submitted their photos and info — ready to review."
              sx={{
                fontSize: '0.62rem',
                fontWeight: 700,
                px: '6px',
                py: '1px',
                borderRadius: '999px',
                bgcolor: 'success.light',
                color: 'success.dark',
                border: '1px solid',
                borderColor: 'success.light',
                letterSpacing: '0.02em',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              Photos received
            </Box>
          )}
        </Box>
      </Box>

      {/* Room rows */}
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        {rooms.map((room, i) => {
          const sc = STAGE_COLORS[room.stageKey] || { bg: BRAND_COLORS.ink3, light: BRAND_COLORS.paper, text: BRAND_COLORS.ink2 };
          const isLast = i === rooms.length - 1;
          return (
            <Box
              key={i}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
                p: '9px 14px',
                cursor: 'pointer',
                borderBottom: isLast ? 'none' : `1px solid ${BRAND_COLORS.stone}`,
                '&:hover': { background: 'rgba(0,0,0,0.03)' },
              }}
            >
              <Typography
                sx={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: BRAND_COLORS.ink2,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {room.roomLabel}
              </Typography>
              {room.fitterName && (
                <Box
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    background: BRAND_COLORS.paper,
                    border: `1px solid ${BRAND_COLORS.stone}`,
                    borderRadius: '999px',
                    px: '8px',
                    py: '2px',
                    fontSize: '0.72rem',
                    fontWeight: 500,
                    color: BRAND_COLORS.ink3,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {room.fitterName}
                </Box>
              )}
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
                  flexShrink: 0,
                }}
              >
                {room.stageKey.charAt(0).toUpperCase() + room.stageKey.slice(1)}
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Action strip — interactive when a handler is configured (isInteractive=true);
          label-only (non-interactive, no chevron) when labelOnly=true. */}
      {actionLabel && (
        <Box
          role={isInteractive ? 'button' : undefined}
          tabIndex={isInteractive ? -1 : undefined}
          title={isInteractive ? 'Run action' : undefined}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: '14px',
            py: '9px',
            bgcolor: actionTint,
            borderTop: `1px solid ${BRAND_COLORS.stone}`,
            cursor: isInteractive ? 'pointer' : 'default',
            transition: 'filter 0.12s',
            '&:hover': isInteractive ? { filter: 'brightness(0.96)' } : undefined,
          }}
        >
          <Typography sx={{ color: actionTextColor, fontWeight: 600, fontSize: '0.78rem' }}>
            {actionLabel}
          </Typography>
          {isInteractive && (
            <ChevronRightIcon sx={{ fontSize: 15, color: actionTextColor, flexShrink: 0 }} />
          )}
        </Box>
      )}

      {/* Continue designing strip */}
      {showContinueDesigning && (
        <Box
          role="button"
          tabIndex={-1}
          title="Continue designing"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: '14px',
            py: '9px',
            bgcolor: 'success.light',
            borderTop: `1px solid ${BRAND_COLORS.stone}`,
            cursor: continuingDesign ? 'wait' : 'pointer',
            opacity: continuingDesign ? 0.7 : 1,
          }}
        >
          <Typography sx={{ color: 'success.dark', fontWeight: 600, fontSize: '0.78rem' }}>
            {continuingDesign ? 'Opening…' : 'Continue designing'}
          </Typography>
          {continuingDesign ? (
            <CircularProgress size={12} sx={{ color: 'success.dark' }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 15, color: 'success.dark', flexShrink: 0 }} />
          )}
        </Box>
      )}
    </Box>
  );
}

// ── Stories ─────────────────────────────────────────────────────────────────

export const NoActionStrip: Story = {
  name: 'No action strip (default)',
  render: () => (
    <DemoProjectCard
      name="Jane Smith"
      contactId="98765"
      rooms={[
        { roomLabel: 'Kitchen', stageKey: 'order' },
        { roomLabel: 'Bedroom', stageKey: 'survey' },
      ]}
    />
  ),
};

export const WithActionStrip: Story = {
  name: 'With action strip (handler matched)',
  render: () => (
    <DemoProjectCard
      name="Alex Johnson"
      contactId="54321"
      rooms={[{ roomLabel: 'Living Room', stageKey: 'designvisit' }]}
      actionLabel="Book Design Visit"
      actionStageKey="designvisit"
    />
  ),
};

export const WithContinueDesigning: Story = {
  name: 'With "Continue designing" strip (draft visit)',
  render: () => (
    <DemoProjectCard
      name="Sam Williams"
      contactId="11111"
      rooms={[{ roomLabel: 'Kitchen', stageKey: 'designvisit' }]}
      showContinueDesigning
    />
  ),
};

export const WithBothStrips: Story = {
  name: 'With action strip + "Continue designing" strip',
  render: () => (
    <DemoProjectCard
      name="Priya Patel"
      contactId="22222"
      rooms={[
        { roomLabel: 'Kitchen', stageKey: 'designvisit', fitterName: 'T. Reid' },
        { roomLabel: 'Study', stageKey: 'sales' },
      ]}
      actionLabel="Start Design Visit"
      actionStageKey="designvisit"
      showContinueDesigning
    />
  ),
};

export const ContinueDesigningLoading: Story = {
  name: '"Continue designing" — loading state',
  render: () => (
    <DemoProjectCard
      name="Morgan Lee"
      contactId="33333"
      rooms={[{ roomLabel: 'Bathroom', stageKey: 'sales' }]}
      showContinueDesigning
      continuingDesign
    />
  ),
};

export const MultiRoomWithInstall: Story = {
  name: 'Multi-room with install date + action strip',
  render: () => (
    <DemoProjectCard
      name="Chris Taylor"
      contactId="44444"
      installLabel="12 Aug"
      rooms={[
        { roomLabel: 'Kitchen', stageKey: 'installation', fitterName: 'J. Davies' },
        { roomLabel: 'Utility', stageKey: 'workshop' },
        { roomLabel: 'Pantry', stageKey: 'packing' },
      ]}
      actionLabel="Confirm Installation"
      actionStageKey="installation"
    />
  ),
};

export const SalesStageAction: Story = {
  name: 'Sales stage — action strip',
  render: () => (
    <DemoProjectCard
      name="Dana Brown"
      contactId="55555"
      rooms={[{ roomLabel: 'Main Kitchen', stageKey: 'sales' }]}
      actionLabel="Follow Up Call"
      actionStageKey="sales"
    />
  ),
};

export const LabelOnlyStripOrder: Story = {
  name: 'Label-only strip — ORDER stage (no handler)',
  parameters: {
    docs: {
      description: {
        story:
          'When an admin configures a text label for a non-sales stage in Card Actions (but no handler), the strip shows with the stage colour tint but is **non-interactive** — no chevron, default cursor. This works for ORDER, WORKSHOP, PACKING, DELIVERY, INSTALLATION, and AFTERCARE stages.',
      },
    },
  },
  render: () => (
    <DemoProjectCard
      name="Oliver Wright"
      contactId="66666"
      rooms={[{ roomLabel: 'Kitchen', stageKey: 'order' }]}
      actionLabel="Order confirmed — awaiting workshop"
      actionStageKey="order"
      labelOnly
    />
  ),
};

export const PhotosReceived: Story = {
  name: 'Photos received badge (AWAITING_PHOTOS + AWPH_RECEIVED)',
  parameters: {
    docs: {
      description: {
        story:
          'Shown when `hs_lead_status === "AWAITING_PHOTOS"` **and** `hw_lead_substatus` contains `"AWPH_RECEIVED"` — set automatically after the customer submits the upload form. The badge disappears as soon as the lead status advances past AWAITING_PHOTOS.',
      },
    },
  },
  render: () => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <DemoProjectCard
        name="Emily Carter"
        contactId="77777"
        rooms={[{ roomLabel: 'Kitchen', stageKey: 'sales' }]}
        photosReceived
      />
      <DemoProjectCard
        name="Marcus Webb"
        contactId="88888"
        rooms={[{ roomLabel: 'Main', stageKey: 'sales' }, { roomLabel: 'Utility', stageKey: 'sales' }]}
        photosReceived
        actionLabel="Book Survey"
        actionStageKey="sales"
      />
    </Box>
  ),
};

export const UrgencyDotRed: Story = {
  name: 'Urgency dot — red (task due within 1 working day)',
  parameters: {
    docs: {
      description: {
        story:
          'A red urgency dot appears before the contact name when the contact has a HubSpot task due within 1 working day. Populated from `/api/contacts/urgency`.',
      },
    },
  },
  render: () => (
    <DemoProjectCard
      name="Rachel Green"
      contactId="91111"
      rooms={[{ roomLabel: 'Kitchen', stageKey: 'sales' }]}
      urgency="red"
    />
  ),
};

export const UrgencyDotOrange: Story = {
  name: 'Urgency dot — orange (task due within 2 working days)',
  parameters: {
    docs: {
      description: {
        story:
          'An orange urgency dot appears before the contact name when the contact has a HubSpot task due within 2 working days.',
      },
    },
  },
  render: () => (
    <DemoProjectCard
      name="Ross Geller"
      contactId="92222"
      rooms={[{ roomLabel: 'Living Room', stageKey: 'designvisit' }]}
      urgency="orange"
      actionLabel="Book Design Visit"
      actionStageKey="designvisit"
    />
  ),
};

export const UrgencyDotAllVariants: Story = {
  name: 'Urgency dots — all variants side by side',
  render: () => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <DemoProjectCard
        name="No urgency (null)"
        contactId="90001"
        rooms={[{ roomLabel: 'Kitchen', stageKey: 'order' }]}
        urgency={null}
      />
      <DemoProjectCard
        name="Orange — due in 2 days"
        contactId="90002"
        rooms={[{ roomLabel: 'Kitchen', stageKey: 'sales' }]}
        urgency="orange"
      />
      <DemoProjectCard
        name="Red — due today or tomorrow"
        contactId="90003"
        rooms={[{ roomLabel: 'Kitchen', stageKey: 'sales' }]}
        urgency="red"
      />
    </Box>
  ),
};
