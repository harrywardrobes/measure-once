import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ADMIN_ACTIVE_GROUP_PREFIX, ADMIN_ACTIVE_GROUP_LEGACY_KEY, ADMIN_ACTIVE_TAB_PREFIX, ADMIN_ACTIVE_TAB_LEGACY_KEY, ADMIN_DEEP_LINK_KEY } from '../../constants/localStorageKeys';
import { GLOBAL_NULL_STAGE_KEY, GLOBAL_NULL_STATUS_KEY, GLOBAL_NULL_SLOT_KEY } from './adminConstants';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  GlobalStyles,
  InputAdornment,
  Paper,
  Stack,
  Step,
  StepConnector,
  StepLabel,
  Stepper,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BoltIcon from '@mui/icons-material/Bolt';
import EmailIcon from '@mui/icons-material/Email';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import CodeIcon from '@mui/icons-material/Code';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMoreRounded from '@mui/icons-material/ExpandMore';
import { GET } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';
import {
  HANDLER_MODAL_SUMMARY,
  HANDLER_EMAIL_TEMPLATES,
  HANDLER_TYPE_LABELS,
  HANDLER_COMPONENT_META,
  HANDLER_OUTCOMES,
  isHandlerType,
} from '../../utils/handlerMeta';
import type { ActionOutcome } from '../../utils/handlerMeta';
import type { HandlerType } from '../../components/CardActionModalsHost';
import { DEFAULT_WORKFLOW, WorkflowDef, WorkflowStage } from '../../lib/workflowConfig';
import { useWorkflow } from '../../hooks/useWorkflow';
import { STAGE_COLORS } from '../../theme';
import { resolveActionLabel } from '../../utils/resolveActionLabel.mjs';
import { DEMO_CONTACT } from '../../components/modals/demoData';
import { MessagePopupModal } from '../../components/modals/MessagePopupModal';
import { ScheduleVisitModal } from '../../components/modals/ScheduleVisitModal';
import { PhoneSummaryModal } from '../../components/modals/PhoneSummaryModal';
import { DepositInvoiceModal } from '../../components/modals/DepositInvoiceModal';

import { UploadPhotosModal } from '../../components/modals/UploadPhotosModal';
import { ArrangeVisitModal } from '../../components/modals/ArrangeVisitModal';
import { DesignVisitFollowupModal } from '../../components/modals/DesignVisitFollowupModal';
import { ContactCustomerModal } from '../../components/modals/ContactCustomerModal';
import { OpenDealActionModal } from '../../components/modals/OpenDealActionModal';
import { DesignVisitWizard } from '../../components/DesignVisitWizard';
const ReviewCustomerPhotosDrawer = React.lazy(() =>
  import('../../components/modals/ReviewCustomerPhotosDrawer').then(m => ({ default: m.ReviewCustomerPhotosDrawer }))
);
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LeadStatus {
  key: string; label: string; stage: string | null;
  sort_order: number; excluded_from_sales: boolean; is_null_row: boolean;
}
interface CALabel { stage_key: string; status_key: string; label: string; }
interface Binding { stage_key?: string; status_key?: string; }
interface Handler {
  id: number; name: string; type: string;
  config: Record<string, unknown>; bindings: Binding[];
}
interface EmailTemplate { key: string; label: string; }

// ── Constants ─────────────────────────────────────────────────────────────────

/** Canonical stage ordering (sales → aftercare). Extra stages fall to the end. */
const CANONICAL_STAGE_ORDER = Object.keys(STAGE_COLORS);

/** show_message is the implicit default — any other type is a "real" binding. */
function isNonDefaultHandler(h: Handler): boolean {
  return h.type !== 'show_message';
}

const CALL_CHAIN_STEPS = [
  { label: 'DOM target',  code: '[data-card-action-handler-id]' },
  { label: 'Hook',        code: 'useCardActionHandlers.ts' },
  { label: 'Dispatcher',  code: 'dispatchCardActionHandler.ts' },
  { label: 'Registry',    code: 'cardActionModalRegistry.ts' },
  { label: 'Host',        code: 'CardActionModalsHost.tsx' },
  { label: 'Modal',       code: null }, // resolved per handler
];

const SHARED_COMPONENTS = [
  {
    name: 'useCardActionHandlers',
    filePath: 'src/react/hooks/useCardActionHandlers.ts',
    role: 'Fetches handler bindings and resolves action labels; re-fetches on BroadcastChannel events',
  },
  {
    name: 'CardActionModalsHost',
    filePath: 'src/react/components/CardActionModalsHost.tsx',
    role: 'Registers itself as the modal opener; renders the correct modal component on dispatch',
  },
  {
    name: 'WorkflowDataContext',
    filePath: 'src/react/context/WorkflowDataContext.tsx',
    role: 'Provides lead statuses and workflow definition across the app via React context',
  },
  {
    name: 'STAGE_COLORS',
    filePath: 'src/react/theme.ts',
    role: 'Maps stage keys to bg/light/text colour tokens used by all stage-aware UI',
  },
  {
    name: 'resolveActionLabel',
    filePath: 'src/react/utils/resolveActionLabel.mjs',
    role: 'Pure resolver for action-strip button labels; shared between hook and test suite',
  },
];

// ── Keyframe styles ────────────────────────────────────────────────────────────

const flashKeyframes = (
  <GlobalStyles styles={`
    @keyframes wf-flash-border {
      0%   { outline: 2px solid transparent; outline-offset: 0px; }
      10%  { outline: 2px solid #8B2BFF;     outline-offset: 1px; }
      80%  { outline: 2px solid #8B2BFF;     outline-offset: 1px; }
      100% { outline: 2px solid transparent; outline-offset: 0px; }
    }
  `} />
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function lsStageToKey(stage: string): string {
  return stage.toLowerCase().replace(/_/g, '');
}

function handlersForSlot(
  handlers: Handler[],
  stageKey: string,
  statusKey: string,
): Handler[] {
  return handlers.filter(h => h.bindings?.some(b =>
    (b.stage_key || '').toLowerCase()  === (stageKey  || '').toLowerCase()
    && (b.status_key || '').toLowerCase() === (statusKey || '').toLowerCase(),
  ));
}

function handlerDisplayName(h: Handler): string {
  return String(h.config?.action_name || (isHandlerType(h.type) ? HANDLER_TYPE_LABELS[h.type] : undefined) || h.name || h.type);
}

function navigateToTab(tabId: string, itemKey?: string | number) {
  try {
    if (itemKey != null) {
      localStorage.setItem(ADMIN_DEEP_LINK_KEY, String(itemKey));
    }
  } catch { /* ignore */ }
  if (typeof (window as unknown as Record<string, unknown>).adminSwitchToTab === 'function') {
    ((window as unknown as Record<string, unknown>).adminSwitchToTab as (id: string) => void)(tabId);
  } else {
    try {
      const uid = (window as unknown as { __moHeaderUser?: { id?: string } }).__moHeaderUser?.id;
      const groupKey = uid ? `${ADMIN_ACTIVE_GROUP_PREFIX}${uid}` : ADMIN_ACTIVE_GROUP_LEGACY_KEY;
      const tabKey   = uid ? `${ADMIN_ACTIVE_TAB_PREFIX}${uid}`   : ADMIN_ACTIVE_TAB_LEGACY_KEY;
      localStorage.setItem(groupKey, 'configuration');
      localStorage.setItem(tabKey, tabId);
    } catch { /* ignore */ }
    location.href = '/admin';
  }
}

function buildStageActionLabelMap(labels: CALabel[]): Record<string, string | null> {
  const m: Record<string, string | null> = {};
  for (const l of labels) {
    const s = l.stage_key.toLowerCase();
    const k = l.status_key.toLowerCase();
    m[`${s}|${k}`] = l.label || null;
  }
  return m;
}

function buildBindingSnapshot(handlers: Handler[]): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const h of handlers) {
    for (const b of h.bindings ?? []) {
      if (!b.stage_key || !b.status_key) continue;
      const key = `${b.stage_key.toLowerCase()}|${b.status_key.toLowerCase()}`;
      snap[key] = h.id;
    }
  }
  return snap;
}

// ── SharedChip ────────────────────────────────────────────────────────────────

function SharedChip() {
  return (
    <Chip
      label="Shared"
      size="small"
      variant="outlined"
      sx={{
        height: 16,
        fontSize: '0.6rem',
        fontWeight: 700,
        letterSpacing: '0.03em',
        color: 'text.secondary',
        borderColor: 'divider',
        '.MuiChip-label': { px: 0.5 },
      }}
    />
  );
}

// ── ActionButtonPreview ───────────────────────────────────────────────────────

function ActionButtonPreview({
  label,
  stageKey,
  hasHandler,
  onClick,
}: {
  label: string;
  stageKey: string;
  hasHandler: boolean;
  onClick?: () => void;
}) {
  const colors = STAGE_COLORS[stageKey];
  if (!hasHandler || !label) {
    return (
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          px: 1.5,
          py: 0.5,
          borderRadius: 1,
          bgcolor: 'action.hover',
          border: '1px dashed',
          borderColor: 'divider',
          opacity: 0.6,
        }}
      >
        <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
          No button label
        </Typography>
      </Box>
    );
  }

  const clickable = Boolean(onClick);
  const button = (
    <Box
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: 1.5,
        py: 0.625,
        borderRadius: 1,
        bgcolor: colors?.bg ?? '#8B2BFF',
        boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
        maxWidth: 200,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'transform 0.12s ease, opacity 0.12s ease',
        ...(clickable && {
          '&:hover': { transform: 'scale(1.04)', opacity: 0.92 },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
        }),
      }}
    >
      <Typography
        variant="caption"
        sx={{
          color: '#fff',
          fontWeight: 700,
          fontSize: '0.7rem',
          lineHeight: 1.2,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </Typography>
    </Box>
  );

  if (!clickable) return button;
  return <Tooltip title="Click to preview modal">{button}</Tooltip>;
}

// ── CallChainStepper ─────────────────────────────────────────────────────────

function CallChainStepper({ handlerType }: { handlerType?: string }) {
  const modalCode = handlerType
    ? ((isHandlerType(handlerType) ? HANDLER_COMPONENT_META[handlerType] : undefined)?.component ?? '(unknown component)')
    : '(no handler bound)';

  const SHARED_STEP_INDICES = new Set([1, 2, 3, 4]);

  return (
    <Stepper
      orientation="vertical"
      connector={
        <StepConnector
          sx={{
            '& .MuiStepConnector-line': {
              minHeight: 8,
              borderLeftWidth: 1,
              borderColor: 'divider',
              ml: '3px',
            },
          }}
        />
      }
      sx={{ py: 0 }}
    >
      {CALL_CHAIN_STEPS.map((step, idx) => {
        const code = idx === 5 ? modalCode : step.code;
        const isShared = SHARED_STEP_INDICES.has(idx);
        return (
          <Step key={step.label} active completed={false} expanded>
            <StepLabel

              sx={{
                py: 0.125,
                '.MuiStepLabel-iconContainer': { pr: 0.75, '& .MuiStepIcon-root': { fontSize: 10, color: '#9ca3af' } },
                '.MuiStepLabel-label': { fontSize: '0.68rem', color: 'text.secondary', lineHeight: 1.3 },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem', minWidth: 52 }}>
                  {step.label}
                </Typography>
                <Box
                  component="code"
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.62rem',
                    bgcolor: 'rgba(0,0,0,0.05)',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 0.5,
                    px: 0.5,
                    py: 0.1,
                    color: 'text.secondary',
                    lineHeight: 1.3,
                    wordBreak: 'break-all',
                  }}
                >
                  {code}
                </Box>
                {isShared && <SharedChip />}
              </Box>
            </StepLabel>
          </Step>
        );
      })}
    </Stepper>
  );
}

// ── OutcomeChipsRow ───────────────────────────────────────────────────────────
// Renders two compact chip rows for a handler's outcomes:
//   • Terminal outcomes (purple filled) — show the lead status written on completion
//   • Partial outcomes (outlined)       — show actions that log progress without moving the card
//
// arrange_visit uses the `variants` record for per-visitType outcomes.
//   • When the handler is configured for a specific visit type
//     (`config.visitType`), each variant outcome collapses to a single chip
//     that shows the matching per-type label (e.g. "Booked → Design visit
//     scheduled" for design, "Booked → Survey scheduled" for survey).
//   • Otherwise the outcome expands into one chip per variant so the overview
//     still shows every per-type result (e.g. "Booked (design)", "Booked
//     (survey)"). The chip's status segment prefers the variant `label` and
//     falls back to the base label / raw lead status when no variant matches.

function OutcomeChipsRow({ outcomes, visitType }: { outcomes: ActionOutcome[]; visitType?: string }) {
  const terminal = outcomes.filter(o => o.kind === 'terminal');
  const partial  = outcomes.filter(o => o.kind === 'partial');

  if (terminal.length === 0 && partial.length === 0) return null;

  type TerminalChip = { label: string; status: string | undefined };
  const terminalChips: TerminalChip[] = [];
  for (const o of terminal) {
    const variantKeys = o.variants ? Object.keys(o.variants) : [];
    if (variantKeys.length > 0) {
      const matched = visitType ? o.variants![visitType] : undefined;
      if (matched) {
        // Configured visit type → single chip with the matching variant label.
        terminalChips.push({ label: o.label, status: matched.label ?? matched.setsLeadStatus });
      } else {
        // No visit type configured (or no matching variant) → expand each
        // variant, falling back to the base outcome label per chip.
        for (const vKey of variantKeys) {
          const vVal = o.variants![vKey];
          terminalChips.push({ label: `${o.label} (${vKey})`, status: vVal.label ?? vVal.setsLeadStatus });
        }
      }
    } else {
      terminalChips.push({ label: o.label, status: o.setsLeadStatus });
    }
  }

  return (
    <>
      {terminalChips.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start' }}>
          <Typography
            variant="caption"
            color="text.disabled"
            sx={{ flexShrink: 0, fontSize: '0.65rem', mt: 0.15 }}
          >
            Outcomes:
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.4 }}>
            {terminalChips.map((c, i) => (
              <Chip
                key={i}
                label={c.status ? `${c.label} → ${c.status}` : `${c.label} → no status change`}
                size="small"
                sx={{
                  height: 18,
                  fontSize: '0.62rem',
                  bgcolor: 'rgba(109,33,205,0.08)',
                  color: 'rgb(109,33,205)',
                  '.MuiChip-label': { px: 0.5 },
                }}
              />
            ))}
          </Box>
        </Box>
      )}
      {partial.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start' }}>
          <Typography
            variant="caption"
            color="text.disabled"
            sx={{ flexShrink: 0, fontSize: '0.65rem', mt: 0.15 }}
          >
            Progress logged:
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.4 }}>
            {partial.map((o, i) => (
              <Chip
                key={i}
                label={o.label}
                size="small"
                variant="outlined"
                sx={{
                  height: 18,
                  fontSize: '0.62rem',
                  color: 'text.secondary',
                  borderColor: 'divider',
                  '.MuiChip-label': { px: 0.5 },
                }}
              />
            ))}
          </Box>
        </Box>
      )}
    </>
  );
}

// ── OutcomeSummaryInline ──────────────────────────────────────────────────────
// Compact one-line outcome summary shown on each collapsed handler row so admins
// can scan every handler's outcomes at a glance without opening the detail card.
//   • Prefix counts every outcome ("3 outcomes:")
//   • Terminal outcomes  → purple filled tint (they move the card / write a status)
//   • Partial outcomes   → outlined muted (progress logging only, no card move)
// Driven entirely by HANDLER_OUTCOMES — no hardcoded outcome lists.

function OutcomeSummaryInline({ outcomes }: { outcomes: ActionOutcome[] }) {
  if (outcomes.length === 0) return null;

  const count = outcomes.length;

  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.4, flexWrap: 'wrap', mt: 0.4 }}>
      <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0, fontSize: '0.6rem' }}>
        {count} outcome{count === 1 ? '' : 's'}:
      </Typography>
      {outcomes.map((o, i) => {
        const isTerminal = o.kind === 'terminal';
        return (
          <Chip
            key={i}
            label={o.label}
            size="small"
            variant={isTerminal ? 'filled' : 'outlined'}
            sx={{
              height: 16,
              fontSize: '0.58rem',
              ...(isTerminal
                ? { bgcolor: 'rgba(109,33,205,0.08)', color: 'rgb(109,33,205)', border: 'none' }
                : { color: 'text.secondary', borderColor: 'divider' }),
              '.MuiChip-label': { px: 0.5 },
            }}
          />
        );
      })}
    </Box>
  );
}

// ── ModalDetailCard ───────────────────────────────────────────────────────────

function ModalDetailCard({
  handler,
  emailTemplates,
}: {
  handler: Handler;
  emailTemplates: EmailTemplate[];
}) {
  const summary = isHandlerType(handler.type) ? HANDLER_MODAL_SUMMARY[handler.type] : undefined;
  const meta    = isHandlerType(handler.type) ? HANDLER_COMPONENT_META[handler.type] : undefined;

  const arrangeVisitType = handler.type === 'arrange_visit'
    ? (handler.config?.visitType as string | undefined)
    : undefined;

  const hubspotText = handler.type === 'start_design_visit' && handler.config?.submittedLeadStatus
    ? `Sets lead status to in-progress on open; to ${handler.config.submittedLeadStatus} on submit`
    : arrangeVisitType
    ? `Configured for ${arrangeVisitType} visits — see outcomes below`
    : summary?.hubspot ?? '';

  const templateKeys  = (isHandlerType(handler.type) ? HANDLER_EMAIL_TEMPLATES[handler.type] : undefined) ?? [];
  const templateItems = templateKeys
    .map(k => emailTemplates.find(t => t.key === k))
    .filter((t): t is EmailTemplate => t !== undefined);

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        borderRadius: 1,
        bgcolor: 'background.default',
        mt: 1,
      }}
    >
      <Stack spacing={0.75}>
        {meta && (
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <CodeIcon sx={{ fontSize: 13, color: 'text.disabled', mt: 0.1 }} />
              <Typography variant="caption" sx={{ fontWeight: 700, fontSize: '0.7rem' }}>
                {meta.component}
              </Typography>
            </Box>
            <Box
              component="code"
              sx={{
                fontFamily: 'monospace',
                fontSize: '0.62rem',
                color: 'text.disabled',
                bgcolor: 'rgba(0,0,0,0.04)',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 0.5,
                px: 0.5,
                py: 0.1,
                lineHeight: 1.4,
              }}
            >
              {meta.filePath}
            </Box>
          </Box>
        )}

        {summary?.steps && (
          <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'baseline' }}>
            <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0, fontSize: '0.65rem' }}>
              Steps:
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.7rem' }}>
              {summary.steps}
            </Typography>
          </Box>
        )}

        {hubspotText && (
          <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'baseline' }}>
            <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0, fontSize: '0.65rem' }}>
              HubSpot:
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic', fontSize: '0.7rem' }}>
              {hubspotText}
            </Typography>
          </Box>
        )}

        {isHandlerType(handler.type) && HANDLER_OUTCOMES[handler.type].length > 0 && (
          <OutcomeChipsRow
            outcomes={HANDLER_OUTCOMES[handler.type]}
            visitType={handler.config?.visitType as string | undefined}
          />
        )}

        <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start' }}>
          <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0, fontSize: '0.65rem', mt: 0.15 }}>
            Emails:
          </Typography>
          {templateItems.length === 0 ? (
            <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic', fontSize: '0.7rem' }}>
              No emails triggered
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.4 }}>
              {templateItems.map(t => (
                <Chip
                  key={t.key}
                  icon={<EmailIcon sx={{ fontSize: 11 }} />}
                  label={t.label}
                  size="small"
                  clickable
                  onClick={() => navigateToTab('emailtemplates', t.key)}
                  sx={{
                    height: 18,
                    fontSize: '0.62rem',
                    bgcolor: 'rgba(16,185,129,0.08)',
                    color: 'rgb(5,150,105)',
                    '&:hover': { bgcolor: 'rgba(16,185,129,0.15)' },
                    '.MuiChip-icon': { color: 'rgb(5,150,105) !important', fontSize: '10px !important' },
                    '.MuiChip-label': { px: 0.5 },
                  }}
                />
              ))}
            </Box>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}

// ── StatusRow ─────────────────────────────────────────────────────────────────

function StatusRow({
  ls,
  stageKey,
  handlers,
  emailTemplates,
  labelMap,
  isFlashing,
  onPreviewClick,
}: {
  ls: LeadStatus;
  stageKey: string;
  handlers: Handler[];
  emailTemplates: EmailTemplate[];
  labelMap: Record<string, string | null>;
  isFlashing: boolean;
  onPreviewClick?: (handler: Handler) => void;
}) {
  const lsKey          = stageKey === GLOBAL_NULL_STAGE_KEY ? GLOBAL_NULL_STATUS_KEY : String(ls.key || '').toLowerCase();
  const statusHandlers = handlersForSlot(handlers, stageKey, lsKey);
  const hasNonDefault  = statusHandlers.some(isNonDefaultHandler);
  const hasHandler     = hasNonDefault;
  const resolvedLabel  = resolveActionLabel(labelMap, stageKey, lsKey, undefined);

  const colors = STAGE_COLORS[stageKey];

  return (
    <Box
      sx={{
        borderBottom: '1px solid',
        borderColor: 'divider',
        '&:last-child': { borderBottom: 'none' },
        opacity: hasHandler ? 1 : 0.45,
        animation: isFlashing ? 'wf-flash-border 1.4s ease-in-out' : 'none',
        borderRadius: 0.5,
        overflow: 'hidden',
      }}
    >
      {/* Three-column row */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '220px 200px 1fr' },
          gap: { xs: 1, md: 1.5 },
          p: 1.5,
          alignItems: 'start',
        }}
      >
        {/* Column 1 — Status Identity */}
        <Box>
          <Typography
            variant="body2"
            sx={{ fontWeight: 700, fontSize: '0.82rem', mb: 0.5, lineHeight: 1.3 }}
          >
            {ls.label}
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.4, mb: 0.4 }}>
            {ls.is_null_row && (
              <Chip
                label="stage default"
                size="small"
                variant="outlined"
                sx={{
                  height: 17,
                  fontSize: '0.6rem',
                  color: 'text.disabled',
                  borderColor: 'divider',
                  '.MuiChip-label': { px: 0.5 },
                }}
              />
            )}
            {ls.excluded_from_sales && (
              <Chip
                label="excluded from sales"
                size="small"
                variant="outlined"
                sx={{
                  height: 17,
                  fontSize: '0.6rem',
                  color: '#92400e',
                  borderColor: '#fbbf24',
                  bgcolor: '#fffbeb',
                  '.MuiChip-label': { px: 0.5 },
                }}
              />
            )}
          </Box>
          {colors && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: colors.bg, flexShrink: 0 }} />
              <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.6rem' }}>
                {stageKey}
              </Typography>
              <SharedChip />
            </Box>
          )}
        </Box>

        {/* Column 2 — Action Button Preview */}
        <Box>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: '0.62rem', mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
            Action button
          </Typography>
          <Box sx={{ mb: 0.75 }}>
            <ActionButtonPreview
              label={resolvedLabel}
              stageKey={stageKey}
              hasHandler={hasHandler}
              onClick={
                hasHandler && onPreviewClick && statusHandlers[0]
                  ? () => onPreviewClick(statusHandlers[0])
                  : undefined
              }
            />
          </Box>
          {hasHandler ? (
            statusHandlers.map(h => (
              <Box key={h.id} sx={{ mb: 0.4 }} data-handler-type={h.type}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                  <Chip
                    icon={<BoltIcon sx={{ fontSize: 12 }} />}
                    label={handlerDisplayName(h)}
                    size="small"
                    clickable
                    onClick={() => navigateToTab('actionhandlers', h.id)}
                    sx={{
                      height: 20,
                      fontSize: '0.68rem',
                      fontWeight: 600,
                      bgcolor: 'rgba(124,58,237,0.1)',
                      color: 'rgb(109,40,217)',
                      '&:hover': { bgcolor: 'rgba(124,58,237,0.2)' },
                      '.MuiChip-icon': { color: 'rgb(109,40,217) !important', fontSize: '11px !important' },
                      '.MuiChip-label': { px: 0.75 },
                    }}
                  />
                </Box>
                <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem', display: 'block', mt: 0.25 }}>
                  type: <Box component="code" sx={{ fontFamily: 'monospace', fontSize: '0.6rem' }}>{h.type}</Box>
                </Typography>
                {isHandlerType(h.type) && (
                  <OutcomeSummaryInline outcomes={HANDLER_OUTCOMES[h.type]} />
                )}
              </Box>
            ))
          ) : (
            <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic', fontSize: '0.7rem' }}>
              Default (show message)
            </Typography>
          )}
        </Box>

        {/* Column 3 — Component & Call Chain */}
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
            <AccountTreeIcon sx={{ fontSize: 11, color: 'text.disabled' }} />
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
              Call chain
            </Typography>
          </Box>
          <CallChainStepper handlerType={hasHandler ? statusHandlers[0]?.type : undefined} />
        </Box>
      </Box>

      {/* Modal Detail Card */}
      {hasHandler && (
        <Box sx={{ px: 1.5, pb: 1.25 }}>
          {statusHandlers.map(h => (
            <ModalDetailCard key={h.id} handler={h} emailTemplates={emailTemplates} />
          ))}
        </Box>
      )}

    </Box>
  );
}

// ── SharedLegend ──────────────────────────────────────────────────────────────

function SharedLegend() {
  const [open, setOpen] = useState(false);
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      <Button
        size="small"
        variant="text"
        onClick={() => setOpen(o => !o)}
        endIcon={open ? <ExpandLess sx={{ fontSize: 14 }} /> : <ExpandMoreRounded sx={{ fontSize: 14 }} />}
        sx={{
          width: '100%',
          justifyContent: 'flex-start',
          textTransform: 'none',
          px: 1.5,
          py: 0.875,
          borderRadius: 0,
          fontSize: '0.78rem',
          fontWeight: 700,
          color: 'text.secondary',
          bgcolor: 'rgba(0,0,0,0.02)',
          '&:hover': { bgcolor: 'rgba(0,0,0,0.05)' },
          gap: 0.5,
        }}
      >
        <SharedChip />
        Shared Components Legend
      </Button>
      <Collapse in={open}>
        <Stack divider={<Divider />}>
          {SHARED_COMPONENTS.map(sc => (
            <Box key={sc.name} sx={{ px: 1.5, py: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.25, flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.78rem' }}>
                  {sc.name}
                </Typography>
                <SharedChip />
                <Box
                  component="code"
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.62rem',
                    color: 'text.disabled',
                    bgcolor: 'rgba(0,0,0,0.04)',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 0.5,
                    px: 0.5,
                    py: 0.1,
                  }}
                >
                  {sc.filePath}
                </Box>
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.7rem' }}>
                {sc.role}
              </Typography>
            </Box>
          ))}
        </Stack>
      </Collapse>
    </Box>
  );
}

// ── StageAccordionNew ─────────────────────────────────────────────────────────

function StageAccordionNew({
  stageKey,
  stageLabel,
  statuses,
  labels,
  handlers,
  emailTemplates,
  searchText,
  flashedSlots,
  accordionRef,
  forcedOpen,
  onPreviewClick,
}: {
  stageKey: string;
  stageLabel: string;
  statuses: LeadStatus[];
  labels: CALabel[];
  handlers: Handler[];
  emailTemplates: EmailTemplate[];
  searchText: string;
  flashedSlots: Set<string>;
  accordionRef?: React.RefObject<HTMLDivElement>;
  forcedOpen?: boolean;
  onPreviewClick?: (handler: Handler) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (forcedOpen) setExpanded(true);
  }, [forcedOpen]);

  const labelMap = useMemo(() => buildStageActionLabelMap(labels), [labels]);

  const stageStatuses = useMemo(() => {
    const q = searchText.toLowerCase().trim();
    let list = statuses
      .filter(s => !s.is_null_row && lsStageToKey(s.stage || '') === stageKey)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    if (q) {
      list = list.filter(ls => {
        const lsKey = ls.key.toLowerCase();
        if (ls.label.toLowerCase().includes(q)) return true;
        const hs = handlersForSlot(handlers, stageKey, lsKey);
        return hs.some(h => {
          if (handlerDisplayName(h).toLowerCase().includes(q)) return true;
          const meta = isHandlerType(h.type) ? HANDLER_COMPONENT_META[h.type] : undefined;
          if (meta?.component.toLowerCase().includes(q)) return true;
          return false;
        });
      });
    }

    return list;
  }, [statuses, stageKey, handlers, searchText]); // eslint-disable-line react-hooks/exhaustive-deps

  const colors = STAGE_COLORS[stageKey];
  const borderColor = colors?.bg ?? '#8B2BFF';

  if (searchText && stageStatuses.length === 0) return null;

  const boundCount = stageStatuses.filter(ls => {
    const lsKey = ls.key.toLowerCase();
    return handlersForSlot(handlers, stageKey, lsKey).some(isNonDefaultHandler);
  }).length;

  return (
    <Box ref={accordionRef} id={`stage-accordion-${stageKey}`}>
      <Accordion
        expanded={expanded}
        onChange={(_, isExpanded) => setExpanded(isExpanded)}
        disableGutters
        variant="outlined"
        sx={{
          borderLeft: `4px solid ${borderColor}`,
          borderRadius: 1,
          '&:not(:last-child)': { mb: 0 },
          '&:before': { display: 'none' },
        }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 48 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%', pr: 1, flexWrap: 'wrap' }}>
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: borderColor,
                flexShrink: 0,
              }}
            />
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{stageLabel}</Typography>
            <Chip
              label={`${boundCount} / ${stageStatuses.length} bound`}
              size="small"
              sx={{
                height: 18,
                fontSize: '0.62rem',
                bgcolor: boundCount > 0 ? 'rgba(124,58,237,0.08)' : 'rgba(0,0,0,0.04)',
                color: boundCount > 0 ? 'rgb(109,40,217)' : 'text.disabled',
                '.MuiChip-label': { px: 0.75 },
              }}
            />
          </Box>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 0 }}>
          {stageStatuses.length === 0 ? (
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                No lead statuses configured for this stage.
              </Typography>
            </Box>
          ) : (
            <Box>
              {stageStatuses.map(ls => {
                const slotKey = `${stageKey}|${ls.key.toLowerCase()}`;
                return (
                  <StatusRow
                    key={ls.key}
                    ls={ls}
                    stageKey={stageKey}
                    handlers={handlers}
                    emailTemplates={emailTemplates}
                    labelMap={labelMap}
                    isFlashing={flashedSlots.has(slotKey)}
                    onPreviewClick={onPreviewClick}
                  />
                );
              })}
            </Box>
          )}
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}

// ── WorkflowDemoModalHost ─────────────────────────────────────────────────────

const DEMO_CTX: CardActionContext = {
  contactId: 'demo-preview',
  contactName: 'Jane Smith',
  contactEmail: DEMO_CONTACT.email,
};

function WorkflowDemoModalHost({
  handler,
  onClose,
}: {
  handler: Handler;
  onClose: () => void;
}) {
  const common = { open: true, onClose, demo: true } as const;
  switch (handler.type) {
    case 'show_message':
      return <MessagePopupModal handler={handler} {...common} />;
    case 'schedule_visit':
      return <ScheduleVisitModal handler={handler} ctx={DEMO_CTX} visitType={handler.config.visitType as string | undefined} {...common} />;
    case 'summarise_phone_call':
      return <PhoneSummaryModal handler={handler} ctx={DEMO_CTX} {...common} />;
    case 'upload_photos_and_info':
      return <UploadPhotosModal handler={handler} ctx={DEMO_CTX} {...common} />;
    case 'arrange_visit':
      return <ArrangeVisitModal handler={handler} ctx={DEMO_CTX} {...common} />;
    case 'design_visit_followup':
      return <DesignVisitFollowupModal handler={handler} ctx={DEMO_CTX} open onClose={onClose} demo />;
    case 'start_design_visit':
      return <DesignVisitWizard handler={handler} ctx={DEMO_CTX} onClose={onClose} demo />;
    case 'review_customer_photos':
      return (
        <React.Suspense fallback={null}>
          <ReviewCustomerPhotosDrawer handler={handler} ctx={DEMO_CTX} open onClose={onClose} demo />
        </React.Suspense>
      );
    case 'open_deal':
      return <OpenDealActionModal handler={handler} ctx={DEMO_CTX} open onClose={onClose} demo />;
    case 'contact_customer':
      return (
        <ContactCustomerModal
          contactId={DEMO_CTX.contactId}
          contactName={DEMO_CTX.contactName}
          contactEmail={DEMO_CTX.contactEmail}
          onClose={onClose}
          demo
        />
      );
    case 'deposit_invoice_followup':
      return (
        <React.Suspense fallback={null}>
          <DepositInvoiceModal handler={handler} ctx={DEMO_CTX} open onClose={onClose} demo />
        </React.Suspense>
      );
    default:
      return (
        <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
          <DialogTitle>Demo preview not available</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary">
              {(isHandlerType(handler.type) ? HANDLER_TYPE_LABELS[handler.type] : undefined) || handler.type} does not have a
              demo-capable modal preview.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Close</Button>
          </DialogActions>
        </Dialog>
      );
  }
}

// ── WorkflowPage ──────────────────────────────────────────────────────────────

export function WorkflowPage() {
  usePageTitle('Workflow · Measure Once');

  const [labels,         setLabels]         = useState<CALabel[]>([]);
  const [statuses,       setStatuses]       = useState<LeadStatus[]>([]);
  const [handlers,       setHandlers]       = useState<Handler[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [loading,        setLoading]        = useState(true);

  const { workflow } = useWorkflow();
  const workflowStages = React.useMemo(() => {
    const wfDef: WorkflowDef = (workflow && typeof workflow === 'object' && workflow.stages) ? workflow : DEFAULT_WORKFLOW;
    const stageEntries = Object.entries(wfDef.stages ?? {}).map(([key, val]: [string, WorkflowStage]) => ({
      key,
      label: val.label ?? key,
    }));
    // Enforce canonical sales→aftercare order; unknown stages fall to the end.
    stageEntries.sort((a, b) => {
      const ai = CANONICAL_STAGE_ORDER.indexOf(a.key);
      const bi = CANONICAL_STAGE_ORDER.indexOf(b.key);
      const an = ai === -1 ? 9999 : ai;
      const bn = bi === -1 ? 9999 : bi;
      return an - bn;
    });
    return stageEntries;
  }, [workflow]);
  const [refreshing,     setRefreshing]     = useState(false);
  const [lastRefreshed,  setLastRefreshed]  = useState<Date | null>(null);
  const [error,          setError]          = useState<string | null>(null);
  const [searchText,       setSearchText]       = useState('');
  const [flashedSlots,     setFlashedSlots]     = useState<Set<string>>(new Set());
  const [forcedOpenStages, setForcedOpenStages] = useState<Set<string>>(new Set());
  const [demoModal,        setDemoModal]        = useState<{ handler: Handler } | null>(null);

  const isFirstLoad          = useRef(true);
  const prevSnapshotRef      = useRef<Record<string, number>>({});
  const flashTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accordionRefs        = useRef<Record<string, React.RefObject<HTMLDivElement>>>({});

  const getAccordionRef = (key: string): React.RefObject<HTMLDivElement> => {
    if (!accordionRefs.current[key]) {
      accordionRefs.current[key] = React.createRef<HTMLDivElement>();
    }
    return accordionRefs.current[key];
  };

  const fetchAll = useCallback(async (showRefreshing = false) => {
    if (isFirstLoad.current) {
      setLoading(true);
    } else if (showRefreshing) {
      setRefreshing(true);
    }
    setError(null);
    try {
      const [lbl, sta, hdl, tpl] = await Promise.all([
        GET<CALabel[]>('/api/admin/stage-action-labels'),
        GET<LeadStatus[]>('/api/admin/lead-statuses'),
        GET<Handler[]>('/api/admin/card-action-handlers'),
        GET<EmailTemplate[]>('/api/admin/email-templates'),
      ]);
      const safeArr = <T,>(x: unknown): T[] => Array.isArray(x) ? x as T[] : [];
      const newHandlers = safeArr<Handler>(hdl);

      // Diff for flash animation (only after first load)
      if (!isFirstLoad.current && showRefreshing) {
        const newSnapshot = buildBindingSnapshot(newHandlers);
        const changed = new Set<string>();
        const allKeys = new Set([
          ...Object.keys(prevSnapshotRef.current),
          ...Object.keys(newSnapshot),
        ]);
        for (const key of allKeys) {
          if (prevSnapshotRef.current[key] !== newSnapshot[key]) {
            changed.add(key);
          }
        }
        if (changed.size > 0) {
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
          setFlashedSlots(changed);
          flashTimerRef.current = setTimeout(() => setFlashedSlots(new Set()), 1500);
        }
        prevSnapshotRef.current = newSnapshot;
      } else if (isFirstLoad.current) {
        prevSnapshotRef.current = buildBindingSnapshot(newHandlers);
      }

      setLabels(safeArr(lbl));
      setStatuses(safeArr(sta));
      setHandlers(newHandlers);
      setEmailTemplates(safeArr(tpl));
      setLastRefreshed(new Date());
    } catch (e) {
      setError((e as Error).message || 'Failed to load workflow data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
      isFirstLoad.current = false;
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Re-fetch when the workflow tab becomes active
  useEffect(() => {
    const tabBtn = document.querySelector('.tab-btn[data-tab="workflow"]');
    if (!tabBtn) return;
    const observer = new MutationObserver(() => {
      if (tabBtn.classList.contains('active')) {
        fetchAll();
      }
    });
    observer.observe(tabBtn, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [fetchAll]);

  // Re-fetch when sibling tabs save changes
  useEffect(() => {
    const EVENTS = ['lead_statuses_changed', 'card_action_handlers_changed'] as const;
    const handler = () => fetchAll();

    for (const evt of EVENTS) {
      window.addEventListener(evt, handler);
    }

    let channels: BroadcastChannel[] = [];
    try {
      channels = EVENTS.map(evt => {
        const bc = new BroadcastChannel(evt);
        bc.addEventListener('message', handler);
        return bc;
      });
    } catch { /* BroadcastChannel not available */ }

    return () => {
      for (const evt of EVENTS) {
        window.removeEventListener(evt, handler);
      }
      for (const bc of channels) {
        bc.close();
      }
    };
  }, [fetchAll]);

  // Clean up flash timer on unmount
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // ── Deep-link: open stage accordion + scroll/flash the matching handler ─────
  useEffect(() => {
    if (loading) return;
    try {
      const raw = localStorage.getItem(ADMIN_DEEP_LINK_KEY);
      if (!raw) return;
      const matched = handlers.filter(h => h.type === raw && isNonDefaultHandler(h));
      if (matched.length === 0) return;
      localStorage.removeItem(ADMIN_DEEP_LINK_KEY);

      const stagesToOpen = new Set<string>();
      const slotsToFlash = new Set<string>();
      for (const h of matched) {
        for (const b of h.bindings ?? []) {
          if (b.stage_key && b.status_key) {
            stagesToOpen.add(b.stage_key.toLowerCase());
            slotsToFlash.add(`${b.stage_key.toLowerCase()}|${b.status_key.toLowerCase()}`);
          }
        }
      }
      if (stagesToOpen.size === 0) return;
      setForcedOpenStages(stagesToOpen);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      setFlashedSlots(slotsToFlash);
      setTimeout(() => {
        try {
          const el = document.querySelector<HTMLElement>(`[data-handler-type="${CSS.escape(raw)}"]`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch { /* ignore */ }
      }, 350);
      flashTimerRef.current = setTimeout(() => {
        setFlashedSlots(new Set());
        setForcedOpenStages(new Set());
      }, 2200);
    } catch { /* ignore */ }
  }, [loading, handlers]); // eslint-disable-line react-hooks/exhaustive-deps

  const formattedTime = lastRefreshed
    ? lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  // ── Global null row ("NEW Contact") — pinned above all stage accordions ──────
  const globalNullRow = useMemo(
    () => statuses.find(s => s.is_null_row) ?? null,
    [statuses],
  );

  const globalLabelMap = useMemo(() => buildStageActionLabelMap(labels), [labels]);

  const showGlobalNullRow = useMemo(() => {
    if (!globalNullRow) return false;
    const q = searchText.toLowerCase().trim();
    if (!q) return true;
    if (globalNullRow.label.toLowerCase().includes(q)) return true;
    const hs = handlersForSlot(handlers, GLOBAL_NULL_STAGE_KEY, GLOBAL_NULL_STATUS_KEY);
    return hs.some(h => {
      if (handlerDisplayName(h).toLowerCase().includes(q)) return true;
      const meta = isHandlerType(h.type) ? HANDLER_COMPONENT_META[h.type] : undefined;
      if (meta?.component.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [globalNullRow, searchText, handlers]);

  const scrollToStage = (key: string) => {
    const ref = accordionRefs.current[key];
    ref?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <>
      {flashKeyframes}
      <Stack spacing={2} sx={{ py: 1 }}>
        {/* ── Header ── */}
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.25 }}>
            <Box sx={{ flexGrow: 1 }}>
              <Typography variant="h6">Workflow</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.72rem' }}>
                This page is a live reference — refresh to reflect the latest handler configuration.
              </Typography>
            </Box>
            {!isFirstLoad.current && formattedTime && (
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                Updated {formattedTime}
              </Typography>
            )}
            <Button
              size="small"
              variant="outlined"
              startIcon={refreshing ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />}
              disabled={refreshing || loading}
              onClick={() => fetchAll(true)}
              data-testid="wf-refresh"
            >
              Refresh
            </Button>
          </Box>
        </Box>

        {/* ── Search ── */}
        <TextField
          size="small"
          placeholder="Filter by status label, handler name, or component…"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                </InputAdornment>
              ),
            },
          }}
          sx={{ '& .MuiInputBase-input': { fontSize: '0.82rem' } }}
        />

        {/* ── Sticky stage-jump nav ── */}
        {!loading && !error && workflowStages.length > 0 && (
          <Box
            sx={{
              position: 'sticky',
              top: 0,
              zIndex: 10,
              bgcolor: 'background.default',
              pt: 0.5,
              pb: 0.75,
              borderBottom: '1px solid',
              borderColor: 'divider',
              mx: -0.5,
              px: 0.5,
            }}
          >
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {workflowStages.map(stage => {
                const colors = STAGE_COLORS[stage.key];
                return (
                  <Tooltip key={stage.key} title={`Jump to ${stage.label}`} arrow>
                    <Chip
                      label={stage.label}
                      size="small"
                      clickable
                      onClick={() => scrollToStage(stage.key)}
                      sx={{
                        height: 22,
                        fontSize: '0.68rem',
                        fontWeight: 600,
                        bgcolor: colors?.bg ?? '#8B2BFF',
                        color: '#fff',
                        '&:hover': { opacity: 0.85, bgcolor: colors?.bg ?? '#8B2BFF' },
                        '.MuiChip-label': { px: 0.75 },
                      }}
                    />
                  </Tooltip>
                );
              })}
            </Box>
          </Box>
        )}

        {/* ── Shared Components Legend ── */}
        {!loading && !error && <SharedLegend />}

        {/* ── Loading / error ── */}
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {error && !loading && (
          <Alert severity="error">{error}</Alert>
        )}

        {/* ── Stage accordions ── */}
        {!loading && !error && (
          <Box>
            {workflowStages.length === 0 ? (
              <Alert severity="warning">
                No stages configured. Add stages in the <strong>Stages</strong> tab to set up your workflow.
              </Alert>
            ) : (
              <Stack spacing={1}>
                {/* ── Global "NEW Contact" row — pinned above all stage accordions ── */}
                {showGlobalNullRow && globalNullRow && (
                  <Paper
                    variant="outlined"
                    sx={{
                      borderRadius: 1,
                      overflow: 'hidden',
                      borderLeft: '4px solid',
                      borderLeftColor: 'divider',
                    }}
                  >
                    <StatusRow
                      ls={globalNullRow}
                      stageKey={GLOBAL_NULL_STAGE_KEY}
                      handlers={handlers}
                      emailTemplates={emailTemplates}
                      labelMap={globalLabelMap}
                      isFlashing={flashedSlots.has(GLOBAL_NULL_SLOT_KEY)}
                      onPreviewClick={(handler) => setDemoModal({ handler })}
                    />
                  </Paper>
                )}

                {workflowStages.map(stage => (
                  <StageAccordionNew
                    key={stage.key}
                    stageKey={stage.key}
                    stageLabel={stage.label}
                    statuses={statuses}
                    labels={labels}
                    handlers={handlers}
                    emailTemplates={emailTemplates}
                    searchText={searchText}
                    flashedSlots={flashedSlots}
                    accordionRef={getAccordionRef(stage.key)}
                    forcedOpen={forcedOpenStages.has(stage.key.toLowerCase())}
                    onPreviewClick={(handler) => setDemoModal({ handler })}
                  />
                ))}
              </Stack>
            )}

            <Stack direction="row" spacing={1.5} sx={{ mt: 2.5 }}>
              <Button
                size="small"
                variant="text"
                data-testid="wf-go-action-handlers"
                onClick={() => navigateToTab('actionhandlers')}
              >
                Go to Action handlers →
              </Button>
              <Button
                size="small"
                variant="text"
                data-testid="wf-go-stages"
                onClick={() => navigateToTab('stages')}
              >
                Go to Stages →
              </Button>
            </Stack>
          </Box>
        )}
      </Stack>

      {demoModal && (
        <WorkflowDemoModalHost
          handler={demoModal.handler}
          onClose={() => setDemoModal(null)}
        />
      )}
    </>
  );
}

export default WorkflowPage;
