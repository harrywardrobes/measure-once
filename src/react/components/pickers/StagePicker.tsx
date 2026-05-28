import { Box, Popover, Typography } from '@mui/material';
import { STAGE_COLORS, BRAND_COLORS } from '../../theme';

// ── Types ──────────────────────────────────────────────────────────────────────

interface StageOption {
  key: string;
  label: string;
}

interface WindowGlobals {
  state?: {
    workflow?: { stages?: Record<string, { label?: string }> };
  };
}

// ── Default stage ordering ─────────────────────────────────────────────────────
// Mirrors STAGE_KEYS in ProjectsPage.tsx. The workflow may define fewer stages;
// only stages that appear in the workflow are shown.

const DEFAULT_STAGE_KEYS = [
  'sales',
  'designvisit',
  'survey',
  'order',
  'workshop',
  'packing',
  'delivery',
  'installation',
  'aftercare',
  'customerservice',
] as const;

const DEFAULT_STAGE_LABELS: Record<string, string> = {
  sales:           'Sales',
  designvisit:     'Design Visit',
  survey:          'Survey',
  order:           'Order',
  workshop:        'Workshop',
  packing:         'Packing',
  delivery:        'Delivery',
  installation:    'Installation',
  aftercare:       'Aftercare',
  customerservice: 'Customer Service',
};

function getStageOptions(): StageOption[] {
  const w = window as unknown as WindowGlobals;
  const workflowStages = w.state?.workflow?.stages;

  if (workflowStages) {
    return DEFAULT_STAGE_KEYS
      .filter((k) => k in workflowStages)
      .map((k) => ({
        key: k,
        label: workflowStages[k]?.label || DEFAULT_STAGE_LABELS[k] || k,
      }));
  }

  return DEFAULT_STAGE_KEYS.map((k) => ({
    key: k,
    label: DEFAULT_STAGE_LABELS[k] || k,
  }));
}

// ── StagePicker ────────────────────────────────────────────────────────────────

export interface StagePickerProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  currentStageKey: string;
  onSelect: (stageKey: string) => void;
}

export function StagePicker({
  anchorEl,
  open,
  onClose,
  currentStageKey,
  onSelect,
}: StagePickerProps) {
  const stages = getStageOptions();

  const handleSelect = (key: string) => {
    onClose();
    if (key !== currentStageKey) onSelect(key);
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{
        paper: {
          sx: {
            mt: 0.5,
            minWidth: 200,
            maxHeight: 380,
            overflowY: 'auto',
            p: '6px',
            border: '1.5px solid',
            borderColor: 'divider',
            borderRadius: 1.5,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          },
        },
      }}
    >
      {stages.map(({ key, label }) => {
        const color = STAGE_COLORS[key];
        const isActive = key === currentStageKey;
        return (
          <Box
            key={key}
            component="button"
            onClick={() => handleSelect(key)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: isActive ? (color?.light || BRAND_COLORS.paper) : 'none',
              color: isActive ? (color?.text || BRAND_COLORS.ink1) : BRAND_COLORS.ink1,
              fontWeight: isActive ? 700 : 400,
              fontSize: '0.82rem',
              fontFamily: 'inherit',
              px: '10px',
              py: '7px',
              cursor: 'pointer',
              borderRadius: '4px',
              transition: 'background 0.1s',
              '&:hover': {
                background: color?.light || BRAND_COLORS.paper,
              },
            }}
          >
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: color?.bg || BRAND_COLORS.ink4,
                flexShrink: 0,
              }}
            />
            <Typography sx={{ fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit' }}>
              {label}
            </Typography>
          </Box>
        );
      })}
    </Popover>
  );
}
