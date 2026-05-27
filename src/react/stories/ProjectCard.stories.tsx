import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Box, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CircularProgress from '@mui/material/CircularProgress';
import { BRAND_COLORS, STAGE_COLORS } from '../theme';

const meta: Meta = {
  title: 'Pages/ProjectCard',
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
}: DemoCardProps) {
  const stageColors = STAGE_COLORS[actionStageKey || rooms[0]?.stageKey || ''];
  const actionTint = stageColors?.light || '#f3f4f6';
  const actionTextColor = stageColors?.text || '#374151';

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
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
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
        <Typography sx={{ fontSize: '0.72rem', fontWeight: 500, color: BRAND_COLORS.ink4, mt: '2px' }}>
          #{contactId}
        </Typography>
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

      {/* Action strip */}
      {actionLabel && (
        <Box
          role="button"
          tabIndex={-1}
          title="Run action"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: '14px',
            py: '9px',
            bgcolor: actionTint,
            borderTop: `1px solid ${BRAND_COLORS.stone}`,
            cursor: 'pointer',
            transition: 'filter 0.12s',
            '&:hover': { filter: 'brightness(0.96)' },
          }}
        >
          <Typography sx={{ color: actionTextColor, fontWeight: 600, fontSize: '0.78rem' }}>
            {actionLabel}
          </Typography>
          <ChevronRightIcon sx={{ fontSize: 15, color: actionTextColor, flexShrink: 0 }} />
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
            bgcolor: '#F0FDF4',
            borderTop: `1px solid ${BRAND_COLORS.stone}`,
            cursor: continuingDesign ? 'wait' : 'pointer',
            opacity: continuingDesign ? 0.7 : 1,
          }}
        >
          <Typography sx={{ color: '#15803d', fontWeight: 600, fontSize: '0.78rem' }}>
            {continuingDesign ? 'Opening…' : 'Continue designing'}
          </Typography>
          {continuingDesign ? (
            <CircularProgress size={12} sx={{ color: '#15803d' }} />
          ) : (
            <ChevronRightIcon sx={{ fontSize: 15, color: '#15803d', flexShrink: 0 }} />
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
